function parseVersion(value) {
    if (typeof value !== "string") return;
    const match = /^(?:opencode\s+)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-z.-]+))?(?:\+[\da-z.-]+)?$/i.exec(value.trim());
    if (!match) return;
    const numbers = match.slice(1, 4).map(Number);
    if (!numbers.every(Number.isSafeInteger)) return;
    return { numbers, prerelease: match[4] };
}

export function nativeReplacement(plugin, hostVersion) {
    if (!plugin.nativeSince || !plugin.nativeCommand) return;
    const current = parseVersion(hostVersion), minimum = parseVersion(plugin.nativeSince);
    if (!current || !minimum) return;
    for (let i = 0; i < current.numbers.length; i++) {
        if (current.numbers[i] < minimum.numbers[i]) return;
        if (current.numbers[i] > minimum.numbers[i]) return `OpenCode ${plugin.nativeSince}+ 已内置 ${plugin.nativeCommand}`;
    }
    if (!current.prerelease) return `OpenCode ${plugin.nativeSince}+ 已内置 ${plugin.nativeCommand}`;
}

export function supportedVersion(plugin, hostVersion) {
    if (!plugin.minimumVersion) return true;
    const current = parseVersion(hostVersion), minimum = parseVersion(plugin.minimumVersion);
    if (!current) return false;
    for (let i = 0; i < 3; i++) {
        if (current.numbers[i] !== minimum.numbers[i]) return current.numbers[i] > minimum.numbers[i];
    }
    return !current.prerelease;
}

export function pluginChoices(items, action) {
    return items.filter(plugin => !plugin.replacedBy && (action !== "remove" || plugin.state !== "absent")).map(plugin => ({
        name: `${plugin.id} — ${plugin.title} [${action === "remove"
            ? plugin.migrating ? "websearch → deepseek-skills · 移除新旧入口" : plugin.replacement ? "已原生内置 · 可卸载旧插件" : "已配置" : plugin.label}]`,
        value: plugin,
        disabled: action !== "install" ? false : plugin.unsupported ? `需要 OpenCode ${plugin.minimumVersion}+`
            : plugin.replacement ? `请使用 OpenCode 原生 ${plugin.nativeCommand}`
            : plugin.state === "current" ? "已是最新" : plugin.state === "unknown" ? "请返回重试" : false,
    }));
}
