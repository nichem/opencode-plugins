import { test } from "bun:test"
import assert from "node:assert/strict"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { jsx } from "@opentui/solid/jsx-runtime"
import plugin from "../tui.js"

test("real sidebar renders and clicks the persisted switch, hides on other models, and restores after switching back", async () => {
  let saved = true, commands: any[] = []
  const handlers = new Map<string, (event: unknown) => void>()
  const slots = new Map<string, () => unknown>()
  const [model, setModel] = createSignal({ modelID: "proxy/DEEPSEEK-v4", providerID: "fixture" })
  const theme = { text: { base: "#ffffff", muted: "#999999",
    feedback: { success: { base: "#00ff00" }, warning: { base: "#ffff00" } } } }
  const ctx: any = {
    theme, location: { directory: "/fixture" },
    client: { rpc: () => ({
      get: async () => ({ enabled: saved }),
      set: async ({ enabled }: { enabled: boolean }) => { saved = enabled; return { enabled } },
      events: { on: (name: string, handler: any) => { handlers.set(name, handler); return () => handlers.delete(name) } },
    }) },
    ui: { model: { current: model }, slot: ({ append, render }: any) => {
      slots.set(append, render); return () => slots.delete(append)
    } },
    keymap: { layer: (factory: any) => { commands = factory().commands } },
  }
  const close = plugin.setup(ctx)
  const screen = await testRender(() => jsx("box", { flexDirection: "column", get children() {
    return [slots.get("app")!(), slots.get("sidebar.content")!()]
  } }), { width: 45, height: 12 })
  try {
    await screen.renderOnce()
    assert.match(screen.captureCharFrame(), /DeepSeek 行为增强/)
    assert.match(screen.captureCharFrame(), /\[开\]/)
    const find = (node: any): any => node.id === "deepseek-behavior-toggle" ? node
      : node.getChildren().map(find).find(Boolean)
    const button = find(screen.renderer.root)
    assert.ok(button)
    await screen.mockMouse.click(button.x + 1, button.y)
    await screen.renderOnce()
    assert.equal(saved, false)
    assert.match(screen.captureCharFrame(), /\[关\]/)
    setModel({ modelID: "gpt-fixture", providerID: "deepseek" })
    await screen.renderOnce()
    assert.doesNotMatch(screen.captureCharFrame(), /DeepSeek 行为增强/)
    setModel({ modelID: "deepseek-r1", providerID: "another-proxy" })
    await screen.renderOnce()
    assert.match(screen.captureCharFrame(), /\[关\]/)
    await commands[0].run()
    await screen.renderOnce()
    assert.equal(saved, true)
    assert.match(screen.captureCharFrame(), /\[开\]/)
    saved = false
    handlers.get("changed")!({ data: { enabled: true } })
    await screen.renderOnce()
    assert.match(screen.captureCharFrame(), /\[关\]/)
  } finally { close(); await screen.dispose() }
  assert.equal(handlers.size, 0)
  assert.equal(slots.size, 0)
})
