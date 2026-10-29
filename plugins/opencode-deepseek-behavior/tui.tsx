import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import { isDeepSeek } from "./src/behavior.ts"
import { BehaviorPanel, type PanelState } from "./src/panel.ts"
import { BehaviorRPC } from "./src/rpc.ts"

export default {
  id: "opencode-deepseek-behavior.tui",
  setup(ctx) {
    const [state, setState] = createSignal<PanelState>({ busy: false })
    const rpc = ctx.client.rpc(BehaviorRPC)
    const panel = new BehaviorPanel((enabled, location, signal) => enabled === undefined
      ? rpc.get({}, { location, signal }) : rpc.set({ enabled }, { location, signal }), setState)
    const stopLocation = ctx.ui.slot({
      append: "app",
      render: () => {
        createEffect(() => panel.select(ctx.location ?? ctx.data.location.default()))
        return null
      },
    })
    const stopSidebar = ctx.ui.slot({
      append: "sidebar.content",
      render: () => <Show when={isDeepSeek(ctx.ui.model.current()?.modelID)}>
        <BehaviorCard ctx={ctx} state={state} toggle={() => panel.toggle()} />
      </Show>,
    })
    // Always re-read authoritative storage; a delayed event may describe an older save.
    const stopChanged = rpc.events.on("changed", () => { void panel.refresh() })
    const timer = setInterval(() => { void panel.refresh() }, 15000)
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
      id: "deepseek-behavior.toggle", title: "切换 DeepSeek 行为增强", group: "DeepSeek", palette: true,
      slash: { name: "deepseek-behavior" }, run: () => panel.toggle(),
    }] }))
    return () => { clearInterval(timer); stopChanged(); stopSidebar(); stopLocation(); panel.dispose() }
  },
} satisfies Plugin.Definition

export function BehaviorCard(props: { ctx: Plugin.Context; state: () => PanelState; toggle: () => Promise<void> }) {
  const label = () => props.state().busy ? props.state().saving ? "保存中…" : "读取中…"
    : props.state().enabled === undefined ? "[重试]" : props.state().enabled ? "[开]" : "[关]"
  return <box flexDirection="column" paddingTop={1} paddingBottom={1} gap={1}>
    <box id="deepseek-behavior-toggle" flexDirection="row" justifyContent="space-between" gap={1}
      onMouseUp={event => { if (event.button !== 0) return; event.stopPropagation(); void props.toggle() }}>
      <text fg={props.ctx.theme.text.base}><b>DeepSeek 行为增强</b></text>
      <text fg={props.state().enabled ? props.ctx.theme.text.feedback.success.base : props.ctx.theme.text.muted}>{label()}</text>
    </box>
    <text fg={props.state().error ? props.ctx.theme.text.feedback.warning.base : props.ctx.theme.text.muted}>
      {props.state().error ?? "进度沟通 · 讨论边界 · 提交授权"}
    </text>
    <text fg={props.ctx.theme.text.muted}>点击切换 · 跨会话保存</text>
  </box>
}
