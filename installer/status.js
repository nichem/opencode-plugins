import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { catalog, identify, repo } from "./catalog.js";
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

function configuredRevisions(configs, id, versions) {
    return configs.flatMap(c => (c.data.plugins ?? []).flatMap(entry => {
        const item = identify(entry);
        if (item?.id !== id) return [];
        const source = typeof entry === "string" ? entry : entry.package;
        return [/^[a-f0-9]{40}$/.test(item.revision) ? item.revision : versions.get(source)];
    }));
}

// Only commit metadata and the root tree are requested; never request blobs,
// recursive trees, commit diffs, or agent document contents.
export async function revisionTrees(revision, request = fetch) {
    if (!/^[a-f0-9]{7,40}$/.test(revision)) throw new Error("无效的提交版本");
    const get = async path => {
        const response = await request(`https://api.github.com/repos/nichem/opencode-plugins/${path}`, {
            headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`GitHub 目录版本检查失败 (${response.status})`);
        return response.json();
    };
    const commits = await get(`commits?sha=${revision}&per_page=1`);
    const commit = commits?.[0];
    if (!/^[a-f0-9]{40}$/.test(commit?.sha) || !commit.sha.startsWith(revision)
        || !/^[a-f0-9]{40}$/.test(commit?.commit?.tree?.sha)) throw new Error("无法解析提交版本");
    const root = await get(`git/trees/${commit.commit.tree.sha}`);
    if (root.truncated || !Array.isArray(root.tree)) throw new Error("目录版本数据不完整");
    return new Map(root.tree.filter(entry => entry.type === "tree" && catalog.some(p => p.id === entry.path)
        && /^[a-f0-9]{40}$/.test(entry.sha)).map(entry => [entry.path, entry.sha]));
}

export async function loadVersionTrees(configs, latest, installed = "", readTrees = revisionTrees) {
    const versions = installedVersions(installed);
    const revisions = new Set(catalog.flatMap(p => configuredRevisions(configs, p.id, versions)).filter(Boolean));
    if (![...revisions].some(ref => ref !== latest)) return new Map();
    revisions.add(latest);
    const results = await Promise.all([...revisions].map(async ref => {
        try { return [ref, await readTrees(ref)]; } catch { return [ref, undefined]; }
    }));
    return new Map(results);
}

export function statuses(configs, latest, installed = "", trees = new Map()) {
    const versions = installedVersions(installed);
    return catalog.map(plugin => {
        const present = configs.filter(c => (c.data.plugins ?? []).some(e => identify(e)?.id === plugin.id));
        if (!present.length) return { ...plugin, state: "absent", label: "未安装" };
        if (!plugin.targets.every(kind => present.some(c => c.kind === kind))) return { ...plugin, state: "repair", label: "配置不完整 · 可修复" };
        if (!latest) return { ...plugin, state: "unknown", label: "更新检查失败 · 请重试" };
        const revisions = configuredRevisions(present, plugin.id, versions);
        if (revisions.some(ref => !ref)) return { ...plugin, state: "repair", label: "版本未知 · 可重新安装" };
        const comparison = revisions.map(ref => {
            if (ref === latest) return true;
            const before = trees.get(ref)?.get(plugin.id), after = trees.get(latest)?.get(plugin.id);
            return before && after ? before === after : undefined;
        });
        if (comparison.includes(undefined)) return { ...plugin, state: "unknown", label: "版本检查失败 · 请重试" };
        const current = comparison.every(Boolean);
        return { ...plugin, state: current ? "current" : "update", label: current ? "已安装 · 最新" : "已安装 · 有更新" };
    });
}
