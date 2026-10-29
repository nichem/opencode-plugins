import { createSignal } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { jsx } from "@opentui/solid/jsx-runtime";
import { PickerModel } from "./picker.js";

// The stock select dialog has no highlight-change callback for hiding an action.
export function PickerView({ ctx, state, sessionID, done }) {
    const model = new PickerModel(state, sessionID);
    const theme = ctx.theme.surface("dialog");
    const [index, setIndex] = createSignal(model.index);
    const canSession = () => { model.index = index(); return model.canSession; };
    const choose = scope => {
        model.index = index();
        const choice = model.choice(scope);
        if (choice) done(choice);
        else if (!model.selected?.available)
            ctx.ui.toast.show({ variant: "info", message: "请先通过 /connect 连接 DSS (DeepSeek Search)" });
    };
    ctx.keymap.layer(() => ({ mode: "global", priority: 30, commands: [
        { bind: "escape", run: () => done() },
        { bind: "return", run: () => choose("default") },
        ...(canSession() ? [{ bind: "s", title: "仅当前会话", run: () => choose("session") }] : []),
    ] }));
    const selected = state.sessionProvider ?? state.defaultProvider;
    const name = id => model.options.find(option => option.id === id)?.name ?? id;
    const label = option => {
        const hint = !option.available ? "未连接" : option.id === "random" ? "自动选择" : option.id === "dss" ? "DeepSeek Search" : undefined;
        return `${state.enabled && option.id === selected ? "✓ " : "  "}${option.name}${hint ? `  · ${hint}` : ""}`;
    };
    const shortcut = (key, title) => jsx("text", { fg: theme.text.muted, children: [
        jsx("span", { style: { fg: theme.text.base, bold: true }, children: key }), ` ${title}`,
    ] });
    return jsx("box", { flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, gap: 1,
        backgroundColor: theme.background.base,
        children: [
            jsx("box", { flexDirection: "column", children: [
                jsx("box", { flexDirection: "row", justifyContent: "space-between", children: [
                    jsx("text", { fg: theme.text.base, attributes: TextAttributes.BOLD, children: "搜索供应商" }),
                    shortcut("Esc", "关闭"),
                ] }),
                jsx("text", { fg: theme.text.muted, children: state.enabled ? [
                    "项目默认  ", jsx("span", { style: { fg: theme.text.action.primary.selected }, children: name(state.defaultProvider) }),
                    ...(state.sessionProvider ? ["  ·  当前会话  ", jsx("span", {
                        style: { fg: theme.text.action.primary.selected }, children: name(state.sessionProvider),
                    })] : []),
                ] : "搜索已禁用 · Enter 保存默认并启用" }),
            ] }),
            jsx("select", {
                options: model.options.map(option => ({ name: label(option), description: "", value: option.id })),
                selectedIndex: model.index, focused: true,
                height: Math.max(1, Math.min(10, (ctx.renderer?.height ?? 24) - 9, model.options.length)),
                showDescription: false, showSelectionIndicator: false, showScrollIndicator: true, wrapSelection: true,
                backgroundColor: theme.background.base, focusedBackgroundColor: theme.background.base,
                textColor: theme.text.base, focusedTextColor: theme.text.base,
                selectedBackgroundColor: theme.background.action.primary.focused, selectedTextColor: theme.text.action.primary.focused,
                onChange: value => setIndex(value), onSelect: () => choose("default"),
            }),
            jsx("box", { flexDirection: "column", children: [
                () => model.options[index()]?.available ? undefined : jsx("text", {
                    fg: theme.text.muted, children: "请先通过 /connect 连接 DSS",
                }),
                jsx("box", { flexDirection: "row", flexWrap: "wrap", columnGap: 2, children: [
                    shortcut("↑↓", "选择"), shortcut("Enter", "保存默认"),
                    () => canSession() ? shortcut("s", "仅当前会话") : undefined,
                ] }),
            ] }),
        ],
    });
}

export function showPicker(ctx, state, sessionID) {
    return new Promise(resolve => {
        let settled = false;
        const done = choice => {
            if (settled) return;
            settled = true;
            ctx.ui.dialog.clear();
            resolve(choice);
        };
        ctx.ui.dialog.set({ size: "medium" });
        ctx.ui.dialog.show(() => jsx(PickerView, { ctx, state, sessionID, done }), () => {
            if (!settled) { settled = true; resolve(); }
        });
    });
}
