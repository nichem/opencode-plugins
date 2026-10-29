import { readFile, mkdir, writeFile, copyFile, unlink, rename } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse, parseTree, findNodeAtLocation, createScanner, SyntaxKind, modify, applyEdits } from "jsonc-parser";
import { identify, specifier } from "./catalog.js";

export function configPaths(env = process.env) {
    const directory = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
    return { server: [...new Set([join(directory, "opencode.json"), join(directory, "opencode.jsonc"), ...(env.OPENCODE_CONFIG ? [resolve(env.OPENCODE_CONFIG)] : [])])], tui: [join(directory, "cli.json")] };
}
async function text(path) { try { return await readFile(path, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
export async function readConfigs(paths = configPaths()) {
    const result = [];
    for (const [kind, files] of Object.entries(paths)) {
        for (const path of files) {
            const original = await text(path), errors = [];
            const data = parse(original ?? "{}", errors, { allowTrailingComma: true });
            if (errors.length || !data || typeof data !== "object" || Array.isArray(data) || (data.plugins !== undefined && !Array.isArray(data.plugins))) throw new Error(`配置格式错误：${path}（未修改）`);
            result.push({ kind, path, original, data });
        }
    }
    return result;
}

function mergeFields(left, right) {
    let result = { ...left };
    for (const [key, value] of Object.entries(right)) {
        if (!Object.hasOwn(result, key)) result = { ...result, [key]: value };
        else if (!isDeepStrictEqual(result[key], value)) {
            const before = result[key];
            if (!before || !value || typeof before !== "object" || typeof value !== "object"
                || Array.isArray(before) || Array.isArray(value)) throw new Error("Conflicting duplicate plugin fields");
            result = { ...result, [key]: mergeFields(before, value) };
        }
    }
    return result;
}

function updatedEntry(matches, plugin, revision, path) {
    const objects = matches.filter(entry => entry && typeof entry === "object");
    if (!objects.length) return specifier(plugin.id, revision);
    let fields = {};
    try {
        for (const { package: _source, ...rest } of objects) fields = mergeFields(fields, rest);
    } catch {
        throw new Error(`${plugin.id} 在 ${path} 存在冲突的重复配置，请先合并选项后重试（未修改配置）`);
    }
    return { ...objects[0], ...fields, package: specifier(plugin.id, revision) };
}

function removeArrayEntry(text, index) {
    const array = findNodeAtLocation(parseTree(text), ["plugins"]);
    const nodes = array.children, node = nodes[index];
    const edits = [{ offset: node.offset, length: node.length, content: "" }];
    // jsonc-parser 3.3.1 truncates the last-item removal range. Remove the
    // value and its separator explicitly, retaining surrounding comments.
    const start = index === nodes.length - 1 && index > 0
        ? nodes[index - 1].offset + nodes[index - 1].length : node.offset + node.length;
    const end = index === nodes.length - 1 && index > 0
        ? node.offset : nodes[index + 1]?.offset ?? array.offset + array.length - 1;
    const scanner = createScanner(text, true);
    scanner.setPosition(start);
    for (let token = scanner.scan(); token !== SyntaxKind.EOF && scanner.getTokenOffset() < end; token = scanner.scan()) {
        if (token === SyntaxKind.CommaToken) {
            edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: "" });
            break;
        }
    }
    return applyEdits(text, edits);
}

export function planChanges(configs, selected, action, revision) {
    return configs.map(config => {
        let entries = [...(config.data.plugins ?? [])];
        let next = config.original ?? "{}\n";
        const edit = (path, value, insertion = false) => {
            next = applyEdits(next, modify(next, path, value, { isArrayInsertion: insertion,
                formattingOptions: { insertSpaces: true, tabSize: 2, eol: next.includes("\r\n") ? "\r\n" : "\n" } }));
        };
        const update = (path, before, after) => {
            if (isDeepStrictEqual(before, after)) return;
            if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
                for (const key of Object.keys(after)) update([...path, key], before[key], after[key]);
            } else edit(path, after);
        };
        for (const plugin of selected) {
            const positions = entries.flatMap((entry, index) => identify(entry)?.id === plugin.id ? [index] : []);
            const matches = positions.map(index => entries[index]);
            const peers = configs.filter(c => c.kind === config.kind);
            // Update every existing occurrence; only create a new entry in one file.
            const exists = peers.some(c => (c.data.plugins ?? []).some(e => identify(e)?.id === plugin.id));
            const destination = peers.find(c => c.original !== null) ?? peers[0];
            const install = action !== "remove" && plugin.targets.includes(config.kind)
                && (matches.length || (!exists && destination === config));
            if (install) {
                // Collapse old/new-path duplicates without dropping any options.
                const entry = updatedEntry(matches, plugin, revision, config.path);
                if (positions.length) {
                    update(["plugins", positions[0]], entries[positions[0]], entry);
                    entries[positions[0]] = entry;
                } else {
                    edit(["plugins", entries.length], entry, true);
                    entries.push(entry);
                }
            }
            for (const index of (install ? positions.slice(1) : positions).toReversed()) {
                next = removeArrayEntry(next, index);
                entries.splice(index, 1);
            }
        }
        if (isDeepStrictEqual(entries, config.data.plugins ?? [])) return { ...config, next: config.original };
        const errors = [];
        const data = parse(next, errors, { allowTrailingComma: true });
        if (errors.length || !isDeepStrictEqual(data, { ...parse(config.original ?? "{}"), plugins: entries }))
            throw new Error(`生成的配置校验失败：${config.path}（未修改配置）`);
        return { ...config, next };
    }).filter(c => c.next !== c.original);
}

export async function writeChanges(changes, backupRoot) {
    if (!changes.length) return;
    const backup = join(backupRoot, `${Date.now()}-${randomUUID()}`);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, "manifest.json"), JSON.stringify(changes.map((c, i) => ({ path: c.path, backup: c.original === null ? null : `${i}.json.bak` })), null, 2), { mode: 0o600 });
    const written = [];
    try {
        for (let i = 0; i < changes.length; i++) {
            const c = changes[i];
            if (await text(c.path) !== c.original) throw new Error(`配置被其他程序修改，请重试：${c.path}`);
            if (c.original !== null) await copyFile(c.path, join(backup, `${i}.json.bak`));
            await mkdir(dirname(c.path), { recursive: true });
            const temporary = join(dirname(c.path), `.opencode-plugins-${randomUUID()}.tmp`);
            try {
                await writeFile(temporary, c.next, { mode: 0o600, flag: "wx" });
                if (await text(c.path) !== c.original) throw new Error(`配置被其他程序修改，请重试：${c.path}`);
                await rename(temporary, c.path);
            } finally {
                await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
            }
            written.push(c);
        }
    } catch (error) {
        for (const c of written.reverse()) {
            if (await text(c.path) !== c.next) continue;
            if (c.original === null) await unlink(c.path); else await writeFile(c.path, c.original);
        }
        throw error;
    }
    return backup;
}
