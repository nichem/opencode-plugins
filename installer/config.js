import { readFile, mkdir, writeFile, copyFile, unlink, rename } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { parse, modify, applyEdits } from "jsonc-parser";
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

export function planChanges(configs, selected, action, revision) {
    return configs.map(config => {
        let entries = [...(config.data.plugins ?? [])];
        for (const plugin of selected) {
            const position = entries.findIndex(entry => identify(entry)?.id === plugin.id);
            const matches = entries.filter(entry => identify(entry)?.id === plugin.id);
            entries = entries.filter(entry => identify(entry)?.id !== plugin.id);
            if (action === "remove" || !plugin.targets.includes(config.kind)) continue;
            const peers = configs.filter(c => c.kind === config.kind);
            // Update every existing occurrence; only create a new entry in one file.
            const exists = peers.some(c => (c.data.plugins ?? []).some(e => identify(e)?.id === plugin.id));
            const destination = peers.find(c => c.original !== null) ?? peers[0];
            if (!matches.length && (exists || destination !== config)) continue;
            // Preserve options and all other entry fields.
            const old = matches.find(entry => typeof entry === "object") ?? matches[0];
            entries.splice(position < 0 ? entries.length : position, 0, typeof old === "object" ? { ...old, package: specifier(plugin.id, revision) } : specifier(plugin.id, revision));
        }
        if (JSON.stringify(entries) === JSON.stringify(config.data.plugins ?? [])) return { ...config, next: config.original };
        const original = config.original ?? "{}\n";
        const next = applyEdits(original, modify(original, ["plugins"], entries, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes("\r\n") ? "\r\n" : "\n" } }));
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
