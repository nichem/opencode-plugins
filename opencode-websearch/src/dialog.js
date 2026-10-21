import { createSignal } from "solid-js";
import { jsx } from "@opentui/solid/jsx-runtime";
import { PickerModel } from "./picker.js";

// The stock select dialog has no highlight-change callback for hiding an action.
export function PickerView({ ctx, state, sessionID, done }) {
    const model = new PickerModel(state, sessionID);
    const [index, setIndex] = createSignal(model.index);
    const canSession = () => { model.index = index(); return model.canSession; };
    const choose = scope => {
        model.index = index();
        const choice = model.choice(scope);
        if (choice) done(choice);
        else if (!model.selected?.available)
            ctx.ui.toast.show({ variant: "info", message: "请先通过 /connect 连接 DeepSeek，再使用 DSS" });
    };
    ctx.keymap.layer(() => ({ mode: "global", priority: 30, commands: [
        { bind: "escape", run: () => done() },
        { bind: "return", run: () => choose("default") },
        ...(canSession() ? [{ bind: "s", title: "仅当前会话", run: () => choose("session") }] : []),
    ] }));
    const selected = state.sessionProvider ?? state.defaultProvider;
    return jsx("box", { flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1, gap: 1,
        children: [
            jsx("text", { fg: ctx.theme.text.base, children: `搜索供应商${state.sessionProvider ? " · 仅当前会话" : ""}` }),
            jsx("text", { fg: ctx.theme.text.muted, children: state.enabled ? `项目默认：${state.defaultProvider}` : "搜索已禁用；Enter 保存默认选择可启用" }),
            jsx("select", {
                options: model.options.map(option => ({ name: `${option.id === selected ? "✓ " : "  "}${option.name}${option.available ? "" : "（未连接）"}`,
                    description: option.id === "random" ? "OpenCode 原生自动选择" : option.available ? option.id : "请先 /connect 连接 DeepSeek",
                    value: option.id })),
                selectedIndex: model.index, focused: true,
                height: Math.max(2, Math.min(14, (ctx.renderer?.height ?? 24) - 12, model.options.length * 2)),
                showDescription: true, showScrollIndicator: true, wrapSelection: true,
                backgroundColor: ctx.theme.background.raised.base, focusedBackgroundColor: ctx.theme.background.raised.base,
                textColor: ctx.theme.text.base, focusedTextColor: ctx.theme.text.base,
                selectedBackgroundColor: ctx.theme.background.action.primary.base, selectedTextColor: ctx.theme.text.action.primary.base,
                descriptionColor: ctx.theme.text.muted, selectedDescriptionColor: ctx.theme.text.action.primary.base,
                onChange: value => setIndex(value), onSelect: () => choose("default"),
            }),
            jsx("text", { fg: ctx.theme.text.muted,
                get children() { return `Enter 保存默认${canSession() ? " · s 仅当前会话" : ""} · Esc 取消`; } }),
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
