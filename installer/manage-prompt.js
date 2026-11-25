import { createPrompt, useState, useKeypress, usePagination, usePrefix, makeTheme, isUpKey, isDownKey, isSpaceKey, isEnterKey } from "@inquirer/core";
import { selectedOperations, toggleChecked, toggleUpdate, selectionLabel, selectionHint } from "./selection.js";

export const managePlugins = createPrompt((config, done) => {
    const theme = makeTheme({}, config.theme);
    const [rows, setRows] = useState(config.rows);
    const [active, setActive] = useState(0);
    const [status, setStatus] = useState("idle");
    const prefix = usePrefix({ status, theme });
    useKeypress(key => {
        if (isEnterKey(key)) {
            setStatus("done");
            done(selectedOperations(rows));
        } else if (key.name === "escape") {
            setStatus("canceled");
            done(undefined);
        } else if (rows.length && (isUpKey(key) || isDownKey(key))) {
            setActive((active + (isUpKey(key) ? -1 : 1) + rows.length) % rows.length);
        } else if (isSpaceKey(key) || (key.name === "u" && !key.ctrl && !key.meta)) {
            setRows(rows.map((row, index) => index !== active ? row : isSpaceKey(key) ? toggleChecked(row) : toggleUpdate(row)));
        }
    });
    const page = usePagination({ items: rows, active, pageSize: config.pageSize ?? 10, loop: true,
        renderItem: ({ item, isActive }) => {
            const line = `${isActive ? ">" : " "} [${item.checked ? "x" : " "}] ${selectionLabel(item)}`;
            return isActive ? theme.style.highlight(line) : line;
        } });
    const count = selectedOperations(rows).length;
    const message = `${prefix} ${theme.style.message("管理插件", status)}`;
    if (status === "done") return `${message} ${count ? `${count} 项变更，等待确认` : "没有变更"}`;
    if (status === "canceled") return `${message} 已返回`;
    return [message, "已安装默认勾选；保持勾选不会自动更新。", page,
        rows[active] ? selectionHint(rows[active]) : "没有可管理的插件。",
        `待变更 ${count} 项 · ↑↓ 移动 · 空格 安装/卸载 · u 更新/修复/迁移 · 回车 预览 · Esc 返回 · Ctrl+C 退出`,
    ].join("\n");
});
