import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { catalog, identify, pluginPath, repo } from "./catalog.js";
import { nativeReplacement } from "./policy.js";
const exec = promisify(execFile);
export async function opencode(command) {
    const commands = { version: ["--version"], list: ["plugin", "list"], reload: ["reload"] };
    const args = commands[command];
    if (!args) throw new Error("Unknown OpenCode command");
    return process.platform === "win32"
        ? exec(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `opencode ${args.join(" ")}`], { windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 })
        : exec("opencode", args, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
}
export async function latestRevision() {
    const { stdout } = await exec("git", ["ls-remote", repo, "refs/heads/main"], { windowsHide: true, timeout: 30000 });
    const sha = stdout.trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("无法获取 GitHub main 版本");
    return sha;
}
function installedVersions(installed) {
    const versions = new Map();
    for (const line of installed.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        const source = columns.at(-1);
        if (identify(source) && /^[a-f0-9]{7,40}$/.test(columns[1])) versions.set(source, columns[1]);
    }
    return versions;
}

function configuredInstallations(configs, id, versions) {
    return configs.flatMap(c => (c.data.plugins ?? []).flatMap(entry => {
        const item = identify(entry);
        if (item?.id !== id) return [];
        const source = typeof entry === "string" ? entry : entry.package;
        return [{ path: item.path, revision: /^[a-f0-9]{40}$/.test(item.revision) ? item.revision : versions.get(source) }];
    }));
}

// Only commit metadata and nonrecursive root/plugins trees are requested.
// Never descend into a plugin, request blobs or read agent documents.
export async function revisionTrees(revision, request = fetch) {
    if (!/^[a-f0-9]{7,40}$/.test(revision)) throw new Error("无效的提交版本");
    const get = async path => {
        const response = await request(`https://api.github.com/repos/nichem/opencode-plugins/${path}`, {
            headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(response.status === 403 && response.headers?.get("x-ratelimit-remaining") === "0"
            ? "GitHub API 匿名请求额度已用尽 (403)" : `GitHub 目录版本检查失败 (${response.status})`);
        return response.json();
    };
    const commits = await get(`commits?sha=${revision}&per_page=1`);
    const commit = commits?.[0];
    if (!/^[a-f0-9]{40}$/.test(commit?.sha) || !commit.sha.startsWith(revision)
        || !/^[a-f0-9]{40}$/.test(commit?.commit?.tree?.sha)) throw new Error("无法解析提交版本");
    const readTree = async sha => {
        const tree = await get(`git/trees/${sha}`);
        if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("目录版本数据不完整");
        return tree.tree;
    };
    const entries = await readTree(commit.commit.tree.sha);
    const known = entry => entry.type === "tree" && catalog.some(p => p.id === entry.path) && /^[a-f0-9]{40}$/.test(entry.sha);
    const trees = new Map(entries.filter(known).map(entry => [entry.path, entry.sha]));
    const container = entries.find(entry => entry.type === "tree" && entry.path === "plugins");
    if (container) {
        if (!/^[a-f0-9]{40}$/.test(container.sha)) throw new Error("插件目录版本无效");
        for (const entry of (await readTree(container.sha)).filter(known)) trees.set(pluginPath(entry.path), entry.sha);
    }
    return trees;
}

// Fetch commits first, then only the root and optional plugins container trees.
// GitHub supports tree:0 but rejects tree:1. No plugin tree or blob is fetched.
export async function gitRevisionTrees(revisions, { run = exec, sources = new Map() } = {}) {
    const refs = [...new Set(revisions)];
    if (refs.some(ref => !/^[a-f0-9]{7,40}$/.test(ref))) throw new Error("无效的提交版本");
    if (!refs.length) return new Map();
    const directory = await mkdtemp(join(tmpdir(), "opencode-plugin-versions-"));
    const git = async args => (await run("git", ["-C", directory, ...args], {
        windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    })).stdout;
    const fetchObjects = args => git(["-c", "protocol.version=2", "fetch", "--quiet", "--no-tags",
        "--no-recurse-submodules", "--filter=tree:0", ...args]);
    let failure;
    const fetchAvailable = async (objects, options = []) => {
        const ids = [...new Set(objects)];
        if (!ids.length) return;
        try { await fetchObjects([...options, repo, ...ids]); }
        catch (error) {
            failure = error;
            // One unavailable object must not discard the other versions.
            if (ids.length > 1) for (const id of ids) {
                try { await fetchObjects([...options, repo, id]); } catch (error) { failure = error; }
            }
        }
    };
    try {
        await git(["init", "--bare", "--quiet"]);
        const full = refs.filter(ref => ref.length === 40);
        const hasShort = refs.some(ref => ref.length < 40);
        if (hasShort) {
            // Abbreviated cache IDs cannot be fetched directly. Resolve them
            // against branch commit metadata, without requesting any trees.
            try { await fetchObjects([repo, "+refs/heads/*:refs/remotes/origin/*"]); }
            catch (error) { failure = error; }
            const tags = new Map(refs.filter(ref => ref.length < 40).map(ref => [ref,
                [...(sources.get(ref) ?? [])].flatMap(name => name.startsWith("refs/tags/") ? [name]
                    : name.startsWith("refs/") ? [] : [`refs/tags/${name}`]) ]));
            const names = [...new Set([...tags.values()].flat())];
            if (names.length) {
                try {
                    // ls-remote also peels annotated tags without downloading
                    // tag targets. Fetch only targets matching the cached SHA.
                    const output = await git(["ls-remote", "--tags", repo, ...names, ...names.map(name => `${name}^{}`)]);
                    const advertised = new Map(output.trim().split(/\r?\n/).flatMap(line => {
                        const match = /^([a-f0-9]{40})\t(refs\/tags\/\S+)$/.exec(line);
                        return match ? [[match[2], match[1]]] : [];
                    }));
                    for (const [ref, names] of tags) for (const name of names) {
                        const sha = advertised.get(`${name}^{}`) ?? advertised.get(name);
                        if (sha?.startsWith(ref)) full.push(sha);
                    }
                } catch (error) { failure = error; }
            }
        }
        await fetchAvailable(full, hasShort ? [] : ["--depth=1"]);
        const roots = new Map();
        for (const ref of refs) {
            try {
                const commit = await git(["cat-file", "commit", ref]);
                const root = /^tree ([a-f0-9]{40})\r?\n/.exec(commit)?.[1];
                if (root) roots.set(ref, root);
            } catch { /* An unresolved or ambiguous cache ID remains unknown. */ }
        }
        if (!roots.size) throw failure ?? new Error("无法解析 Git 提交版本");
        await fetchAvailable(roots.values());
        const readTree = async sha => {
            const output = await git(["ls-tree", "-d", "-z", sha]);
            return new Map(output.split("\0").flatMap(line => {
                const match = /^040000 tree ([a-f0-9]{40})\t(.+)$/.exec(line);
                return match && (match[2] === "plugins" || catalog.some(p => p.id === match[2])) ? [[match[2], match[1]]] : [];
            }));
        };
        const containers = new Map();
        for (const root of new Set(roots.values())) {
            try { containers.set(root, await readTree(root)); }
            catch { /* An unavailable root affects only its own revisions. */ }
        }
        await fetchAvailable([...containers.values()].map(tree => tree.get("plugins")).filter(Boolean));
        const nested = new Map();
        for (const sha of new Set([...containers.values()].map(tree => tree.get("plugins")).filter(Boolean))) {
            try { nested.set(sha, await readTree(sha)); }
            catch { /* Leave unavailable paths unknown, retaining valid legacy paths. */ }
        }
        const trees = new Map();
        for (const [root, container] of containers) {
            const tree = new Map([...container].filter(([path]) => path !== "plugins"));
            for (const [id, sha] of nested.get(container.get("plugins")) ?? [])
                if (id !== "plugins") tree.set(pluginPath(id), sha);
            trees.set(root, tree);
        }
        return new Map([...roots].filter(([, root]) => trees.has(root)).map(([ref, root]) => [ref, trees.get(root)]));
    } finally {
        if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("无效的临时目录");
        await rm(directory, { recursive: true, force: true });
    }
}

export async function loadVersionTrees(configs, latest, installed = "", readTrees = revisionTrees,
    { readGitTrees = gitRevisionTrees, report = () => {}, hostVersion } = {}) {
    const versions = installedVersions(installed);
    const supported = catalog.filter(plugin => !nativeReplacement(plugin, hostVersion));
    const revisions = new Set(supported.flatMap(p => configuredInstallations(configs, p.id, versions)).map(item => item.revision).filter(Boolean));
    if (![...revisions].some(ref => ref !== latest)) return new Map();
    revisions.add(latest);
    const failures = new Map();
    const results = await Promise.all([...revisions].map(async ref => {
        try { return [ref, await readTrees(ref)]; } catch (error) { failures.set(ref, error); return [ref, undefined]; }
    }));
    const trees = new Map(results);
    if (failures.size) {
        report(`${failures.values().next().value.message}；正在改用 Git 元数据检查版本…`);
        try {
            const sources = new Map();
            for (const config of configs) for (const entry of config.data.plugins ?? []) {
                const item = identify(entry);
                if (!item || !supported.some(plugin => plugin.id === item.id)) continue;
                const source = typeof entry === "string" ? entry : entry.package;
                const ref = versions.get(source);
                if (!ref || ref.length === 40 || !failures.has(ref)) continue;
                if (!sources.has(ref)) sources.set(ref, new Set());
                sources.get(ref).add(item.revision);
            }
            const fallback = await readGitTrees([...failures.keys()], { sources });
            for (const ref of failures.keys()) if (fallback.has(ref)) trees.set(ref, fallback.get(ref));
        } catch { /* Keep failed checks unknown; never infer latest. */ }
        if ([...failures.keys()].some(ref => !trees.get(ref))) {
            report("部分 Git 目录版本仍无法确认；请检查 Git 和 GitHub 网络连接后重试。未修改配置。");
        }
    }
    return trees;
}

export function statuses(configs, latest, installed = "", trees = new Map(), { hostVersion } = {}) {
    const versions = installedVersions(installed);
    return catalog.map(plugin => {
        const present = configs.filter(c => (c.data.plugins ?? []).some(e => identify(e)?.id === plugin.id));
        const replacement = nativeReplacement(plugin, hostVersion);
        if (replacement) return { ...plugin, replacement, state: present.length ? "retired" : "absent",
            label: present.length ? "已原生内置 · 建议卸载旧插件" : "已原生内置 · 无需安装" };
        if (!present.length) return { ...plugin, state: "absent", label: "未安装" };
        if (!plugin.targets.every(kind => present.some(c => c.kind === kind))) return { ...plugin, state: "repair", label: "配置不完整 · 可修复" };
        if (!latest) return { ...plugin, state: "unknown", label: "更新检查失败 · 请重试" };
        const installations = configuredInstallations(present, plugin.id, versions);
        if (installations.some(item => !item.revision)) return { ...plugin, state: "repair", label: "版本未知 · 可重新安装" };
        const canonical = pluginPath(plugin.id);
        const migration = installations.some(item => item.path !== canonical);
        const duplicate = present.some(config => (config.data.plugins ?? []).filter(entry => identify(entry)?.id === plugin.id).length > 1);
        const comparison = installations.map(({ revision: ref, path }) => {
            if (ref === latest) return true;
            const before = trees.get(ref)?.get(path), after = trees.get(latest)?.get(canonical);
            return before && after ? before === after : undefined;
        });
        if (comparison.includes(undefined)) return { ...plugin, state: "unknown", label: "版本检查失败 · 请重试" };
        const current = comparison.every(Boolean);
        if (migration) return { ...plugin, state: current ? "repair" : "update", label: current ? "旧目录地址 · 需要迁移" : "有更新 · 需要迁移" };
        if (duplicate) return { ...plugin, state: "repair", label: "重复配置 · 可修复" };
        return { ...plugin, state: current ? "current" : "update", label: current ? "已安装 · 最新" : "已安装 · 有更新" };
    });
}
