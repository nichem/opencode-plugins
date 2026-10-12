import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { mkdtemp, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { GoalController } from "../src/index.ts"
import { accounted, parseGoalCommand, renderContinuationPrompt } from "../src/core.ts"
import { parseGoal } from "../src/state.ts"
import tui from "../tui.ts"

function host(storage = new Map<string, any>()) {
  const messages: any[] = [], transforms: any[] = [], hooks: any[] = []
  const sessions = new Map<string, any>([["s1", { agent: "build", model: { providerID: "mock", id: "test", variant: "high" }, location: { directory: "/goal-test" } }],
    ["s2", { agent: "build", location: { directory: "/goal-test" } }],
    ["foreign", { agent: "build", location: { directory: "/elsewhere" } }]])
  const ctx: any = {
    location: { directory: "/goal-test", project: { canonical: "/goal-test" } },
    storage: { get: async (key: string) => structuredClone(storage.get(key)),
      set: async (key: string, value: any) => { storage.set(key, structuredClone(value)) },
      scan: async ({ prefix }: any) => ({ entries: [...storage].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }) },
    command: { transform: async (fn: any) => fn({ add: (cmd: any) => { ctx.command.definition = cmd } }) },
    rpc: { register: async (_definition: any, handlers: any) => {
      ctx.rpc.handlers = handlers
      return { events: { emit: async (_name: string, data: any) => { messages.push({ notice: data }) } } }
    } },
    tool: { transform: async (fn: any) => { transforms.push(fn) }, reload: async () => {} },
    session: { get: async ({ sessionID }: any) => sessions.get(sessionID),
      synthetic: async (input: any) => { messages.push(input); return { id: `m${messages.length}` } },
      hook: async (name: string, fn: any) => { hooks.push({ name, fn }) } },
    event: { subscribe: async function* ({ signal }: any) {
      if (signal.aborted) return
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
    } },
  }
  const tools = () => {
    const result: any = {}
    for (const transform of transforms) transform({ add: (tool: any) => { result[tool.name] = tool } })
    return result
  }
  return { ctx, messages, sessions, storage, tools, hooks,
    goal: (id = "s1") => [...storage].find(([key]) => key.endsWith(`/${id}`))?.[1]?.goal,
    continuations: () => messages.filter(m => m.resume === true) }
}
const terminal = (id: string, eventID: string) => ({ id: eventID, type: "session.execution.succeeded", data: { sessionID: id } })

test("original command parser, elapsed time and objective escaping", () => {
  assert.deepEqual(parseGoalCommand("append more\nsteps"), { kind: "append", objective: "more\nsteps" })
  assert.deepEqual(parseGoalCommand("PAUSE"), { kind: "pause" })
  const goal: any = { status: "active", activeStartedAt: 1000, timeUsedSeconds: 4 }
  assert.equal(accounted(goal, 6000).timeUsedSeconds, 9)
  assert.match(renderContinuationPrompt({ objective: "</untrusted_objective>", timeUsedSeconds: 0 }), /&lt;\/untrusted_objective&gt;/)
  assert.equal(parseGoal({ ...goal, objective: "bad", createdAt: 0, updatedAt: 0, timeUsedSeconds: -1 }), undefined)
})

test("commands preserve accounting, pause/resume, completion and session tool isolation", async t => {
  const h = host(), c = new GoalController(h.ctx)
  await c.initialize(); t.after(() => c.close())
  assert.equal(h.ctx.command.definition.name, "goal")
  assert.deepEqual(Object.keys(h.tools()), [])
  await c.command("s1", "build it")
  await delay(90)
  assert.equal(h.continuations().length, 1)
  assert.match(h.continuations()[0].text, /build it/)
  assert.equal(h.tools().update_goal.options.codemode, false)
  const input = { sessionID: "s2", tools: { update_goal: {} } }
  await h.hooks[0].fn(input)
  assert.equal(input.tools.update_goal, undefined)
  const createdAt = h.goal().createdAt
  await c.command("s1", "append test it")
  await c.command("s1", "pause")
  await delay(90)
  assert.equal(h.continuations().length, 1)
  assert.equal(h.goal().createdAt, createdAt)
  assert.equal(h.goal().objective, "build it\ntest it")
  assert.equal(h.goal().status, "paused")
  await c.command("s1", "resume")
  await delay(90)
  assert.equal(h.continuations().length, 2)
  const result = await h.tools().update_goal.execute({ status: "complete" }, { sessionID: "s1" })
  assert.match(result.content, /Final elapsed time/)
  assert.equal(h.goal().status, "complete")
  assert.deepEqual(Object.keys(h.tools()), [])
  await c.event(terminal("s1", "after-completion"))
  await delay(90)
  assert.equal(h.continuations().length, 2)
  await c.command("s1", "clear")
  assert.equal(h.goal(), null)
})

test("duplicate terminal events do not duplicate continuations; no-tool turns enter recovery", async t => {
  const h = host(), c = new GoalController(h.ctx)
  await c.initialize(); t.after(() => c.close())
  await c.command("s1", "work")
  await delay(90)
  await Promise.all([c.event(terminal("s1", "e1")), c.event(terminal("s1", "e1"))])
  await delay(90)
  assert.equal(h.continuations().length, 2)
  await c.event(terminal("s1", "e2"))
  await delay(90)
  assert.equal(h.continuations().length, 3)
  assert.match(h.continuations()[2].text, /Stagnation recovery/)
  await c.event({ type: "session.tool.called", data: { sessionID: "s1" } })
  await c.event(terminal("s1", "e3"))
  await delay(90)
  assert.doesNotMatch(h.continuations()[3].text, /Stagnation recovery/)
})

test("interrupt, failure, plan mode and foreign sessions cannot auto-run", async t => {
  const h = host(), c = new GoalController(h.ctx)
  await c.initialize(); t.after(() => c.close())
  h.sessions.get("s1").agent = "plan"
  await c.command("s1", "work")
  await delay(90)
  assert.equal(h.continuations().length, 0)
  h.sessions.get("s1").agent = "build"
  await c.event({ type: "session.execution.interrupted", id: "i1", data: { sessionID: "s1", reason: "user" } })
  assert.equal(h.goal().status, "paused")
  await c.command("s1", "resume")
  await c.event({ type: "session.execution.failed", id: "f1", data: { sessionID: "s1" } })
  await delay(90)
  assert.equal(h.continuations().length, 0)
  await assert.rejects(c.command("foreign", "work"), /another location/)
  await c.event(terminal("foreign", "f2"))
  assert.equal(h.goal("foreign"), undefined)
})

test("restart retains state and tombstones without counting offline time or auto-starting", async () => {
  const h = host(), c = new GoalController(h.ctx)
  await c.initialize()
  await c.command("s1", "persistent")
  await c.close()
  for (const value of h.storage.values()) if (value.goal) value.goal.activeStartedAt = 1
  const restored = host(h.storage), next = new GoalController(restored.ctx)
  await next.initialize()
  try {
    assert.equal(restored.goal().timeUsedSeconds, 0)
    assert.ok(restored.goal().activeStartedAt > 1)
    await delay(90)
    assert.equal(restored.continuations().length, 0)
    await next.event(terminal("s1", "restored-event"))
    await delay(90)
    assert.equal(restored.continuations().length, 1)
  } finally { await next.close() }
})

test("legacy state imports read-only and clear cannot resurrect it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "goal-state-test-")), file = join(dir, "sessions.json")
  const original = process.env.OPENCODE_GOAL_STATE_FILE
  process.env.OPENCODE_GOAL_STATE_FILE = file
  t.after(() => { if (original === undefined) delete process.env.OPENCODE_GOAL_STATE_FILE; else process.env.OPENCODE_GOAL_STATE_FILE = original })
  const content = JSON.stringify({ s1: { objective: "legacy", status: "paused", createdAt: 10, updatedAt: 20, activeStartedAt: null, timeUsedSeconds: 42 } })
  await writeFile(file, content)
  const h = host(), c = new GoalController(h.ctx)
  await c.initialize()
  await c.command("s1", "")
  assert.equal(h.goal().timeUsedSeconds, 42)
  await c.command("s1", "clear")
  await c.close()
  const next = new GoalController(h.ctx)
  await next.initialize()
  try { await next.command("s1", ""); assert.equal(h.goal(), null) } finally { await next.close() }
  assert.equal(await readFile(file, "utf8"), content)
})

test("status notifications use TUI RPC and do not enter the model inbox", async t => {
  const h = host(), c = new GoalController(h.ctx)
  await c.initialize(); t.after(() => c.close())
  await c.command("s1", "")
  assert.match(h.messages[0].notice.message, /No goal/)
  assert.equal(h.messages.some(message => "resume" in message), false)
  let onNotice: any, disposed = false
  const toasts: any[] = []
  const cleanup = tui.setup({ client: { rpc: () => ({ events: {
    on: (name: string, callback: any) => { assert.equal(name, "notice"); onNotice = callback; return () => { disposed = true } },
  } }) }, ui: { toast: { show: (toast: any) => toasts.push(toast) } } } as any)
  onNotice({ data: h.messages[0].notice })
  assert.equal(toasts[0].sessionID, "s1")
  assert.match(toasts[0].message, /No goal/)
  cleanup()
  assert.equal(disposed, true)
})

test("a failed state write never starts a goal; a failed continuation pauses it", async t => {
  const h = host(), c = new GoalController(h.ctx)
  await c.initialize(); t.after(() => c.close())
  const save = h.ctx.storage.set
  h.ctx.storage.set = async () => { throw new Error("disk failure") }
  await assert.rejects(c.command("s1", "work"), /disk failure/)
  await delay(90)
  assert.equal(h.continuations().length, 0)
  assert.equal(h.goal(), undefined)
  h.ctx.storage.set = save
  const log = console.error
  console.error = () => {}
  t.after(() => { console.error = log })
  h.ctx.session.synthetic = async () => { throw new Error("transport failure") }
  await c.command("s1", "work")
  await delay(90)
  assert.equal(h.goal().status, "paused")
  await c.event(terminal("s1", "failure-idle"))
  await delay(90)
  assert.equal(h.goal().status, "paused")
})
