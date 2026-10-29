import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../index.ts"
import { BEHAVIOR_PROMPT, BehaviorSettings } from "../src/behavior.ts"
import { BehaviorPanel } from "../src/panel.ts"

function storage() {
  const data = new Map<string, unknown>()
  return { data, get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => { data.set(key, value) } }
}

async function host(saved = storage()) {
  const hooks = new Map<string, (event: any) => Promise<void>>()
  const removed: string[] = [], events: any[] = []
  let methods: any
  const ctx: any = {
    storage: saved,
    rpc: { register: async (_definition: unknown, handlers: any) => {
      methods = handlers
      return { dispose: async () => { removed.push("rpc") },
        events: { emit: async (type: string, data: unknown) => { events.push({ type, data }) } } }
    } },
    session: { hook: async (name: string, handler: any) => {
      hooks.set(name, handler)
      return { dispose: async () => { removed.push(name) } }
    } },
  }
  const close = await plugin.setup(ctx)
  return { hooks, methods, saved, removed, events, close: close as () => Promise<void> }
}

const event = (id: string, providerID = "arbitrary", sessionID = "s1") => ({
  sessionID, model: { id, providerID }, system: [{ type: "text", text: "Artificial original instruction" }],
  messages: [{ role: "user", content: [{ type: "text", text: "Artificial question" }] }],
  tools: { bash: { description: "Fixture", input: {} } }, options: { temperature: 0.3 },
})

test("only case-insensitive model-ID matches receive one additive prompt; unrelated request fields stay intact", async () => {
  const h = await host()
  try {
    assert.deepEqual([...h.hooks.keys()], ["context"])
    const hook = h.hooks.get("context")!
    for (const id of ["deepseek-v4", "DeepSeek-R1", "vendor/DEEPSEEK-custom", "my-deepseek-model"]) {
      const input = event(id), original = structuredClone(input)
      await hook(input)
      assert.deepEqual(input, { ...original, system: [...original.system, { type: "text", text: BEHAVIOR_PROMPT }] })
      await hook(input)
      assert.equal(input.system.filter(part => part.text === BEHAVIOR_PROMPT).length, 1)
    }
    for (const id of ["gpt-5", "claude", "", "deep-seek"]) {
      const input = event(id, "deepseek"), original = structuredClone(input)
      await hook(input)
      assert.deepEqual(input, original)
    }
  } finally { await h.close() }
  assert.deepEqual(h.removed, ["context", "rpc"])
})

test("a saved off switch survives sessions, provider changes and plugin restarts, and can be re-enabled", async () => {
  const saved = storage(), first = await host(saved)
  assert.deepEqual(await first.methods.get({}), { enabled: true })
  await first.methods.set({ enabled: false })
  assert.deepEqual(first.events.at(-1), { type: "changed", data: { enabled: false } })
  for (const sessionID of ["s1", "s2"]) {
    const input = event("deepseek-v4", "some-proxy", sessionID)
    await first.hooks.get("context")!(input)
    assert.equal(input.system.length, 1)
  }
  await first.close()
  const second = await host(saved)
  try {
    assert.deepEqual(await second.methods.get({}), { enabled: false })
    await second.methods.set({ enabled: true })
    const input = event("deepseek-v4")
    await second.hooks.get("context")!(input)
    assert.equal(input.system.length, 2)
  } finally { await second.close() }
})

test("fresh settings instances read shared durable storage and failed saves do not change the switch", async () => {
  const saved = storage(), a = new BehaviorSettings(saved), b = new BehaviorSettings(saved)
  await a.set(false)
  assert.deepEqual(await b.get(), { enabled: false })
  await b.set(true)
  assert.deepEqual(await a.get(), { enabled: true })
  const set = saved.set
  saved.set = async () => { throw new Error("Fixture disk failure") }
  await assert.rejects(a.set(false), /disk failure/)
  assert.deepEqual(await a.get(), { enabled: true })
  saved.set = set
  await a.set(false)
  assert.deepEqual(await b.get(), { enabled: false })
})

test("a request waits for an in-flight switch save and sees its durable result", async () => {
  const saved = storage(), settings = new BehaviorSettings(saved)
  let release!: () => void
  const set = saved.set
  saved.set = async (...args) => { await new Promise<void>(resolve => { release = resolve }); await set(...args) }
  const saving = settings.set(false)
  await Promise.resolve()
  await Promise.resolve()
  const reading = settings.get()
  release()
  assert.deepEqual(await saving, { enabled: false })
  assert.deepEqual(await reading, { enabled: false })
})

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
test("sidebar waits for persistence, ignores duplicate clicks, and recovers after an uncertain save", async () => {
  let saved = true, writes = 0, fail = false, release!: () => void
  const panel = new BehaviorPanel(async enabled => {
    if (enabled !== undefined) {
      writes++
      await new Promise<void>(resolve => { release = resolve })
      if (fail) throw new Error("Fixture network failure")
      saved = enabled
    }
    return { enabled: saved }
  }, () => {})
  try {
    panel.select({ directory: "/fixture" }); await tick()
    assert.equal(panel.state.enabled, true)
    const saving = panel.toggle()
    assert.equal(panel.state.enabled, true)
    assert.equal(panel.state.saving, true)
    await panel.toggle()
    assert.equal(writes, 1)
    release(); await saving
    assert.equal(panel.state.enabled, false)
    fail = true
    const uncertain = panel.toggle(); release(); await uncertain
    assert.equal(panel.state.enabled, undefined)
    assert.match(panel.state.error!, /未确认/)
    await panel.toggle()
    assert.equal(panel.state.enabled, false)
  } finally { panel.dispose() }
})

test("old location responses and disposed work cannot overwrite the current sidebar state", async () => {
  const requests: { resolve: (value: { enabled: boolean }) => void; signal: AbortSignal }[] = []
  const panel = new BehaviorPanel((_enabled, _location, signal) => new Promise(resolve => {
    requests.push({ resolve, signal })
  }), () => {})
  panel.select({ directory: "/a" })
  panel.select({ directory: "/b" })
  assert.equal(requests[0].signal.aborted, true)
  requests[1].resolve({ enabled: false }); await tick()
  requests[0].resolve({ enabled: true }); await tick()
  assert.equal(panel.state.enabled, false)
  const refresh = panel.refresh()
  panel.dispose()
  requests[2].resolve({ enabled: true }); await refresh
  assert.equal(panel.state.enabled, false)
})

test("hanging transport times out locally and can be retried", async () => {
  let hang = true
  const panel = new BehaviorPanel(() => hang ? new Promise(() => {}) : Promise.resolve({ enabled: false }), () => {}, 15)
  try {
    panel.select({ directory: "/fixture" })
    await new Promise(resolve => setTimeout(resolve, 35))
    assert.equal(panel.state.busy, false)
    assert.match(panel.state.error!, /读取失败/)
    hang = false
    await panel.refresh()
    assert.equal(panel.state.enabled, false)
  } finally { panel.dispose() }
})
