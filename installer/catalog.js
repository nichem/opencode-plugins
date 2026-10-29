export const repo = "https://github.com/nichem/opencode-plugins.git";
export const catalog = [
    { id: "opencode-providers", title: "供应商：Qoder CN / Krill", targets: ["server"] },
    { id: "opencode-goal", title: "目标管理与自动续跑（旧版兼容）", targets: ["server", "tui"], nativeSince: "2.2.1", nativeCommand: "/goal" },
    { id: "opencode-message-delete", title: "删除末尾 AI 消息", targets: ["tui"] },
    { id: "opencode-agents", title: "内置 Markdown agent", targets: ["server"] },
    { id: "opencode-quota", title: "当前供应商额度侧栏", targets: ["server", "tui"] },
    { id: "opencode-websearch", title: "搜索供应商选择 / DeepSeek Search", targets: ["server", "tui"] },
    { id: "opencode-ui", title: "UI 优化：思考实时计时 / 末尾收起", targets: ["tui"] },
    { id: "opencode-deepseek-behavior", title: "DeepSeek 行为增强与持久化开关", targets: ["server", "tui"] },
];
export const pluginPath = id => `plugins/${id}`;
export const specifier = (id, revision) => `git+${repo}#${revision}::path:${pluginPath(id)}`;
export function identify(entry) {
    const value = typeof entry === "string" ? entry : entry?.package;
    if (typeof value !== "string") return;
    const match = /^(git\+https:\/\/github\.com\/nichem\/opencode-plugins(?:\.git)?|github:nichem\/opencode-plugins|nichem\/opencode-plugins)#([^:]+)::path:((?:plugins\/)?([^/]+))\/?$/.exec(value);
    if (!match || !catalog.some(p => p.id === match[4])) return;
    return { id: match[4], revision: match[2], path: match[3] };
}
