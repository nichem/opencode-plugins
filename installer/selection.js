export const actionLabels = { install: "安装", update: "更新", repair: "修复", migrate: "迁移", remove: "卸载" };

export function createSelection(items, revision) {
    return items.filter(plugin => !plugin.replacedBy).map(plugin => {
        const installed = plugin.state !== "absent";
        const blocked = plugin.unsupported ? `需要 OpenCode ${plugin.minimumVersion}+`
            : plugin.replacement ? `请使用 OpenCode 原生 ${plugin.nativeCommand}`
            : !/^[a-f0-9]{40}$/.test(revision ?? "") ? "更新检查失败 · 请返回重试"
            : plugin.state === "unknown" ? "版本检查失败 · 请返回重试" : undefined;
        const updateAction = !blocked && installed && ["update", "repair"].includes(plugin.state)
            ? plugin.migrating || plugin.pathMigration ? "migrate" : plugin.state : undefined;
        return { plugin, installed, checked: installed, update: false, blocked, updateAction };
    });
}

export function toggleChecked(row) {
    if (!row.installed && row.blocked) return row;
    return { ...row, checked: !row.checked, update: false };
}

export function toggleUpdate(row) {
    if (!row.checked || !row.updateAction) return row;
    return { ...row, update: !row.update };
}

function pendingAction(row) {
    if (row.installed && !row.checked) return "remove";
    if (!row.installed && row.checked) return "install";
    if (row.update && row.checked) return row.updateAction;
}

export function selectedOperations(rows) {
    return rows.flatMap(row => {
        const action = pendingAction(row);
        return action ? [{ plugin: row.plugin, action }] : [];
    });
}

export function selectionLabel(row) {
    const action = pendingAction(row);
    const status = [row.plugin.label, row.blocked, action ? `待${actionLabels[action]}` : undefined].filter(Boolean).join(" · ");
    return `${row.plugin.id} — ${row.plugin.title} [${status}]`;
}

export function selectionHint(row) {
    if (!row.installed) return row.blocked ?? (row.checked ? "空格取消待安装" : "空格标记安装");
    if (!row.checked) return "空格恢复保持原样；重新勾选后不会自动更新";
    if (row.update) return `u 取消待${actionLabels[row.updateAction]}；空格改为卸载`;
    return row.updateAction ? `空格标记卸载；u 标记${actionLabels[row.updateAction]}`
        : `空格标记卸载；${row.blocked ?? "当前无需更新"}`;
}

export function operationSummary({ plugin, action }) {
    const detail = plugin.migrating
        ? action === "remove" ? "（移除 websearch / deepseek-skills 新旧入口）" : "（websearch → deepseek-skills：卸载旧插件，安装新插件）"
        : plugin.pathMigration && action !== "remove" ? "（旧目录地址 → plugins/）" : "";
    return `${actionLabels[action]}：${plugin.id}${detail}`;
}

export async function reviewOperations(operations, { confirm, report = console.log }) {
    if (!operations.length) { report("没有变更，未修改配置。"); return false; }
    report("\n将执行以下变更：");
    for (const operation of operations) report(`  ${operationSummary(operation)}`);
    if (operations.some(({ plugin, action }) => action === "remove" || plugin.migrating))
        report("卸载仅移除配置，保留账号、凭据、缓存和插件数据。");
    if (operations.some(({ plugin }) => plugin.migrating))
        report("旧 websearch 的 dss 默认供应商将改为 random；项目中单独设置的 dss 需自行调整。");
    return confirm({ message: `确认执行以上 ${operations.length} 项变更？`, default: false });
}
