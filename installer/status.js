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
export function statuses(configs, latest, installed = "") {
    const versions = new Map();
    for (const line of installed.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        const item = identify(columns.at(-1));
        if (item && /^[a-f0-9]{7,40}$/.test(columns[1])) versions.set(item.id, columns[1]);
    }
    return catalog.map(plugin => {
        const present = configs.filter(c => (c.data.plugins ?? []).some(e => identify(e)?.id === plugin.id));
        if (!present.length) return { ...plugin, state: "absent", label: "未安装" };
        if (!plugin.targets.every(kind => present.some(c => c.kind === kind))) return { ...plugin, state: "repair", label: "配置不完整 · 可修复" };
        if (!latest) return { ...plugin, state: "unknown", label: "更新检查失败 · 请重试" };
        const refs = present.flatMap(c => c.data.plugins.filter(e => identify(e)?.id === plugin.id).map(e => identify(e).revision));
        const revisions = refs.map(ref => /^[a-f0-9]{40}$/.test(ref) ? ref : versions.get(plugin.id));
        if (revisions.some(ref => !ref)) return { ...plugin, state: "repair", label: "版本未知 · 可重新安装" };
        const current = revisions.every(ref => latest.startsWith(ref));
        return { ...plugin, state: current ? "current" : "update", label: current ? "已安装 · 最新" : "已安装 · 有更新" };
    });
}
