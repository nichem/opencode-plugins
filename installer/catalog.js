export const repo = "https://github.com/nichem/opencode-plugins.git";
export const catalog = [
    { id: "opencode-providers", title: "供应商：Qoder CN / Krill", targets: ["server"] },
    { id: "opencode-goal", title: "目标管理与自动续跑", targets: ["server", "tui"] },
    { id: "opencode-message-delete", title: "删除末尾 AI 消息", targets: ["tui"] },
    { id: "opencode-agents", title: "内置 Markdown agent", targets: ["server"] },
    { id: "opencode-quota", title: "当前供应商额度侧栏", targets: ["server", "tui"] },
    { id: "opencode-websearch", title: "搜索供应商选择 / DeepSeek Search", targets: ["server", "tui"] },
];
export const specifier = (id, revision) => `git+${repo}#${revision}::path:${id}`;
export function identify(entry) {
    const value = typeof entry === "string" ? entry : entry?.package;
    if (typeof value !== "string") return;
    const match = /^(git\+https:\/\/github\.com\/nichem\/opencode-plugins(?:\.git)?|github:nichem\/opencode-plugins|nichem\/opencode-plugins)#([^:]+)::path:([^/]+)\/?$/.exec(value);
    if (!match || !catalog.some(p => p.id === match[3])) return;
    return { id: match[3], revision: match[2] };
}
