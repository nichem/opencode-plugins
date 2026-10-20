import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { formatReset, formatValue, remaining, type QuotaItem } from "./src/data.ts"
import { milliseconds } from "./src/options.ts"
import { QuotaPanel, type PanelState } from "./src/panel.ts"
import { QuotaRPC } from "./src/rpc.ts"

export default {
  id: "opencode-quota.tui",
  setup(ctx) {
    const refreshMs = ctx.options.refreshMs === 0 ? 0 : milliseconds(ctx.options.refreshMs, 60000, 10000, 3600000)
    const requestTimeoutMs = milliseconds(ctx.options.requestTimeoutMs, 15000, 1000, 120000)
    const [state, setState] = createSignal<PanelState>({ loading: false })
    const rpc = ctx.client.rpc(QuotaRPC)
    const panel = new QuotaPanel((selection, signal) => rpc.query(selection, {
      location: ctx.location ?? ctx.data.location.default(), signal,
    }), value => setState(value), refreshMs, requestTimeoutMs)

    const stopModel = ctx.ui.slot({
      append: "app",
      render: () => {
        createEffect(() => {
          const model = ctx.ui.model.current()
          const location = ctx.location ?? ctx.data.location.default()
          panel.select(model ? { providerID: model.providerID, modelID: model.modelID } : undefined,
            JSON.stringify([location.directory, location.workspaceID]))
        })
        onCleanup(() => panel.select(undefined))
        return null
      },
    })
    const stopSidebar = ctx.ui.slot({
      append: "sidebar.content",
      render: () => <QuotaCard ctx={ctx} state={state} />,
    })
    const stopSwitch = ctx.data.on("credential.switched", () => panel.invalidate())
    const stopUpdate = ctx.data.on("credential.updated", () => panel.invalidate())
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
      id: "quota.refresh", title: "刷新当前供应商额度", group: "Quota", palette: true,
      slash: { name: "quota-refresh" }, run: () => panel.refresh(),
    }] }))

    return () => { panel.dispose(); stopSwitch(); stopUpdate(); stopSidebar(); stopModel() }
  },
} satisfies Plugin.Definition

function QuotaCard(props: { ctx: Plugin.Context; state: () => PanelState }) {
  const { ctx } = props
  const [now, setNow] = createSignal(Date.now())
  const clock = setInterval(() => setNow(Date.now()), 30000)
  onCleanup(() => clearInterval(clock))
  const providerName = createMemo(() => {
    const selection = props.state().selection
    if (!selection) return ""
    return ctx.data.location.provider.list(ctx.location ?? ctx.data.location.default())
      ?.find(provider => provider.id === selection.providerID)?.name ?? selection.providerID
  })
  const color = (item: QuotaItem) => (remaining(item) ?? 100) <= 10 ? ctx.theme.text.feedback.error.base
    : (remaining(item) ?? 100) <= 40 ? ctx.theme.text.feedback.warning.base : ctx.theme.text.feedback.success.base

  return <Show when={props.state().selection}>
    <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={ctx.theme.text.base}><b>额度</b></text>
        <text fg={props.state().error ? ctx.theme.text.feedback.warning.base : ctx.theme.text.muted}>
          {props.state().loading ? "刷新中…" : props.state().error ? "更新失败" : props.state().result?.status === "ready" ? "已更新" : "未配置"}
        </text>
      </box>
      <box flexDirection="column">
        <text fg={ctx.theme.text.action.primary.base}>{props.state().result?.title ?? providerName()}</text>
        <text fg={ctx.theme.text.muted}>{props.state().selection?.modelID}</text>
      </box>
      <For each={props.state().result?.items ?? []}>{item => <box flexDirection="column">
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={ctx.theme.text.base}>{item.label}</text>
          <text fg={color(item)}>{formatValue(item)}</text>
        </box>
        <Show when={remaining(item) !== undefined}>
          <box flexDirection="row"><text fg={color(item)}>{"━".repeat(Math.round((remaining(item) ?? 0) / 5))}</text><text fg={ctx.theme.border.base}>{"─".repeat(20 - Math.round((remaining(item) ?? 0) / 5))}</text></box>
        </Show>
        <Show when={item.resetsAt}>{reset => <text fg={ctx.theme.text.muted}>{formatReset(reset(), now())}</text>}</Show>
      </box>}</For>
      <Show when={props.state().error ?? props.state().result?.message}>{message =>
        <text fg={props.state().error ? ctx.theme.text.feedback.warning.base : ctx.theme.text.muted}>{message()}</text>
      }</Show>
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <Show when={props.state().result?.updatedAt}>{time =>
          <text fg={ctx.theme.text.muted}>{props.state().error ? "上次数据 " : "更新于 "}{new Date(time()).toLocaleTimeString("zh-CN", { hour12: false })}</text>
        }</Show>
        <text fg={ctx.theme.text.muted}>/quota-refresh</text>
      </box>
    </box>
  </Show>
}
