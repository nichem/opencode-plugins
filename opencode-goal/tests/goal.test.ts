import assert from "node:assert/strict"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { mkdtemp, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { GoalController } from "../src/index.ts"
import { accounted, formatGoalSummary, parseGoalCommand, renderContinuationPrompt, type GoalState } from "../src/core.ts"
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
      wait: async () => {},
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

test("accounting preserves subsecond time across checkpoints, pause and persistence", () => {
  let goal: GoalState = { objective: "work", status: "active", createdAt: 0, updatedAt: 0,
    activeStartedAt: 0, timeUsedSeconds: 0 }
  for (let now = 900; now <= 9000; now += 900) goal = accounted(goal, now)
  assert.ok(Math.abs(goal.timeUsedSeconds - 9) < 1e-9)
  goal = { ...accounted(goal, 9500), status: "paused", activeStartedAt: null }
  const restored = parseGoal(JSON.parse(JSON.stringify(goal)))!
  assert.ok(Math.abs(restored.timeUsedSeconds - 9.5) < 1e-9)
  assert.equal(accounted(restored, 20000).timeUsedSeconds, restored.timeUsedSeconds)
  const resumed = { ...restored, status: "active" as const, activeStartedAt: 20000 }
  assert.match(formatGoalSummary(resumed, 20500), /Time used: 10s/)
  assert.match(formatGoalSummary({ ...resumed, activeStartedAt: 0, timeUsedSeconds: 0 }, 1500), /Time used: 1s/)
})

test("busy sessions keep continuations local and pause/clear/completion cancel admission", async t => {
  for (const operation of ["pause", "clear", "complete"]) {
    const h = host(), c = new GoalController(h.ctx)
    let release!: () => void, aborted = false
    h.ctx.session.wait = async (_input: unknown, { signal }: { signal: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        release = resolve
        signal.addEventListener("abort", () => { aborted = true; reject(signal.reason) }, { once: true })
      })
    }
    await c.initialize(); t.after(() => c.close())
    await c.command("s1", "work")
    await delay(90)
    assert.equal(h.continuations().length, 0)
    if (operation === "complete") await h.tools().update_goal.execute({ status: "complete" }, { sessionID: "s1" })
    else await c.command("s1", operation)
    assert.equal(aborted, true)
    release()
    await delay(90)
    assert.equal(h.continuations().length, 0)
  }
})

test("updates replace pending waits and terminal events do not duplicate admission", async t => {
  const h = host(), c = new GoalController(h.ctx)
  const releases: (() => void)[] = []
  // Also simulate a host wait that resolves despite cancellation: the stale
  // continuation must still be rejected by the generation check.
  h.ctx.session.wait = () => new Promise<void>(resolve => releases.push(resolve))
  await c.initialize(); t.after(() => c.close())
  await c.command("s1", "old task")
  await delay(90)
  await c.command("s1", "new task")
  await delay(90)
  await c.command("s1", "append latest requirement")
  await delay(90)
  await c.event(terminal("s1", "busy-finished"))
  await delay(90)
  assert.equal(releases.length, 3)
  releases.forEach(release => release())
  await delay(90)
  assert.equal(h.continuations().length, 1)
  assert.match(h.continuations()[0].text, /new task\nlatest requirement/)
  assert.doesNotMatch(h.continuations()[0].text, /old task/)
})

test("cancellation invalidates admission during every post-idle asynchronous boundary", async t => {
  for (const boundary of ["get", "save", "reload"]) {
    for (const action of ["pause", "clear", "replacement task", "append new requirement", "user", "complete"]) {
      await t.test(`${boundary}: ${action}`, async () => {
        const h = host(), c = new GoalController(h.ctx)
        let signal!: AbortSignal, release!: () => void, entered = false
        h.ctx.session.wait = async (_input: unknown, options: { signal: AbortSignal }) => { signal = options.signal }
        await c.initialize()
        try {
          await c.command("s1", "original task")
          const target = boundary === "get" ? h.ctx.session : boundary === "save" ? h.ctx.storage : h.ctx.tool
          const key = boundary === "get" ? "get" : boundary === "save" ? "set" : "reload"
          const original = target[key]
          target[key] = async (...args: any[]) => {
            target[key] = original
            entered = true
            await new Promise<void>(resolve => { release = resolve })
            return original(...args)
          }
          await delay(90)
          assert.equal(entered, true)
          const mutation = action === "user"
            ? c.event({ type: "session.inbox.enqueued", data: { sessionID: "s1", item: { type: "user" } } })
            : action === "complete"
              ? h.tools().update_goal.execute({ status: "complete" }, { sessionID: "s1" })
              : c.command("s1", action)
          assert.equal(signal.aborted, true, "Cancellation must not wait for the serial queue")
          release()
          await mutation
          assert.equal(h.continuations().length, 0, "The obsolete admission must never reach synthetic()")
          await delay(90)
          const replaced = action === "replacement task" || action.startsWith("append")
          assert.equal(h.continuations().length, replaced ? 1 : 0)
          if (replaced) assert.match(h.continuations()[0].text, /replacement task|new requirement/)
        } finally { release?.(); await c.close() }
      })
    }
  }
})

test("event subscription delivers cancellation even while an earlier event awaits the serial queue", async () => {
  const h = host(), c = new GoalController(h.ctx)
  let deliver!: () => void, release!: () => void, signal!: AbortSignal
  const ready = new Promise<void>(resolve => { deliver = resolve })
  h.ctx.event.subscribe = async function* ({ signal }: { signal: AbortSignal }) {
    await ready
    yield { type: "session.tool.called", data: { sessionID: "s1" } }
    yield { type: "session.inbox.enqueued", data: { sessionID: "s1", item: { type: "user" } } }
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
  }
  h.ctx.session.wait = async (_input: unknown, options: { signal: AbortSignal }) => { signal = options.signal }
  await c.initialize()
  try {
    await c.command("s1", "work")
    const save = h.ctx.storage.set
    h.ctx.storage.set = async (...args: any[]) => {
      h.ctx.storage.set = save
      await new Promise<void>(resolve => { release = resolve })
      return save(...args)
    }
    await delay(90)
    deliver()
    await delay(20)
    assert.equal(signal.aborted, true)
    release()
    await delay(90)
    assert.equal(h.continuations().length, 0)
  } finally { deliver(); release?.(); await c.close() }
})

test("an in-flight submission receives cancellation without pausing a replacement goal", async () => {
  const h = host(), c = new GoalController(h.ctx)
  let signal!: AbortSignal
  const send = h.ctx.session.synthetic
  h.ctx.session.synthetic = async (_input: unknown, options: { signal: AbortSignal }) => {
    h.ctx.session.synthetic = send
    signal = options.signal
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  }
  await c.initialize()
  try {
    await c.command("s1", "old task")
    await delay(90)
    await c.command("s1", "replacement task")
    assert.equal(signal.aborted, true)
    await delay(90)
    assert.equal(h.goal().status, "active")
    assert.equal(h.continuations().length, 1)
    assert.match(h.continuations()[0].text, /replacement task/)
  } finally { await c.close() }
})

test("shutdown cancels idle waits and staged reverts never receive continuations", async () => {
  const h = host(), c = new GoalController(h.ctx)
  let aborted = false
  h.ctx.session.wait = (_input: unknown, { signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason) }, { once: true })
  })
  await c.initialize()
  await c.command("s1", "work")
  await delay(90)
  await c.close()
  assert.equal(aborted, true)
  assert.equal(h.continuations().length, 0)
  const restored = host(h.storage), next = new GoalController(restored.ctx)
  restored.sessions.get("s1").revert = { messageID: "assistant" }
  await next.initialize()
  try {
    await next.event(terminal("s1", "reverted"))
    await delay(90)
    assert.equal(restored.continuations().length, 0)
  } finally { await next.close() }
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
  const elapsed = h.goal().timeUsedSeconds
  for (const value of h.storage.values()) if (value.goal) value.goal.activeStartedAt = 1
  const restored = host(h.storage), next = new GoalController(restored.ctx)
  await next.initialize()
  try {
    assert.equal(restored.goal().timeUsedSeconds, elapsed)
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

test("failed edits restore the original goal's timer or idle wait", async t => {
  for (const stage of ["timer", "waiting"]) {
    for (const edit of ["append more", "replacement"]) {
      await t.test(`${stage}: ${edit}`, async () => {
        const h = host(), c = new GoalController(h.ctx)
        let release!: () => void
        if (stage === "waiting") h.ctx.session.wait = (_input: unknown, { signal }: { signal: AbortSignal }) =>
          new Promise<void>((resolve, reject) => {
            release = resolve
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          })
        await c.initialize()
        try {
          await c.command("s1", "original")
          if (stage === "waiting") await delay(90)
          const save = h.ctx.storage.set
          h.ctx.storage.set = async () => { h.ctx.storage.set = save; throw new Error("disk failure") }
          await assert.rejects(c.command("s1", edit), /disk failure/)
          assert.equal(h.goal().objective, "original")
          await delay(90)
          if (stage === "waiting") { release(); await delay(20) }
          assert.equal(h.goal().status, "active")
          assert.equal(h.continuations().length, 1)
          assert.match(h.continuations()[0].text, /<untrusted_objective>\noriginal\n<\/untrusted_objective>/)
        } finally { release?.(); await c.close() }
      })
    }
  }
})

test("failed edit recovery never overrides a newer pause, clear, edit or user input", async t => {
  for (const action of ["pause", "clear", "new task", "user"]) {
    await t.test(action, async () => {
      const h = host(), c = new GoalController(h.ctx)
      let rejectWrite!: () => void, entered!: () => void
      const writing = new Promise<void>(resolve => { entered = resolve })
      await c.initialize()
      try {
        await c.command("s1", "original")
        const save = h.ctx.storage.set
        h.ctx.storage.set = async () => {
          h.ctx.storage.set = save
          entered()
          await new Promise<void>((_resolve, reject) => { rejectWrite = () => reject(new Error("disk failure")) })
        }
        const failed = assert.rejects(c.command("s1", "append obsolete"), /disk failure/)
        await writing
        const newer = action === "user"
          ? c.event({ type: "session.inbox.enqueued", data: { sessionID: "s1", item: { type: "user" } } })
          : c.command("s1", action)
        rejectWrite()
        await Promise.all([failed, newer])
        await delay(90)
        assert.equal(h.continuations().length, action === "new task" ? 1 : 0)
        if (action === "new task") assert.match(h.continuations()[0].text, /new task/)
      } finally { rejectWrite?.(); await c.close() }
    })
  }
})

test("replayed failure and interruption events cannot cancel resumed goals, including after restart", async t => {
  for (const type of ["session.execution.failed", "session.execution.interrupted"]) {
    for (const restart of [false, true]) {
      await t.test(`${type}, restart=${restart}`, async () => {
        let h = host(), c = new GoalController(h.ctx)
        await c.initialize()
        try {
          await c.command("s1", "work")
          const event = { id: "terminal-id", type, data: { sessionID: "s1", reason: "user" } }
          await Promise.all([c.event(event), c.event(event)])
          assert.equal(h.goal().status, "paused")
          if (restart) {
            await c.close()
            h = host(h.storage); c = new GoalController(h.ctx)
            await c.initialize()
          }
          await c.command("s1", "resume")
          await c.event(event)
          await delay(90)
          assert.equal(h.goal().status, "active")
          assert.equal(h.continuations().length, 1)
        } finally { await c.close() }
      })
    }
  }
})

test("a terminal event whose storage write failed can be retried", async () => {
  const h = host(), c = new GoalController(h.ctx)
  await c.initialize()
  try {
    await c.command("s1", "work")
    const event = { id: "retry-id", type: "session.execution.interrupted", data: { sessionID: "s1", reason: "user" } }
    const save = h.ctx.storage.set
    h.ctx.storage.set = async () => { h.ctx.storage.set = save; throw new Error("disk failure") }
    await assert.rejects(c.event(event), /disk failure/)
    await c.event(event)
    assert.equal(h.goal().status, "paused")
    await delay(90)
    assert.equal(h.continuations().length, 0)
  } finally { await c.close() }
})

test("explicit resume repairs failed pause/clear without automatically restarting", async t => {
  for (const action of ["pause", "clear"]) {
    for (const stage of ["timer", "waiting", "submitting"]) {
      await t.test(`${action}: ${stage}`, async () => {
        const h = host(), c = new GoalController(h.ctx)
        let entered = false
        if (stage !== "timer") {
          const key = stage === "waiting" ? "wait" : "synthetic"
          const original = h.ctx.session[key]
          h.ctx.session[key] = async (_input: unknown, { signal }: { signal: AbortSignal }) => {
            h.ctx.session[key] = original
            entered = true
            await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
          }
        }
        await c.initialize()
        try {
          await c.command("s1", "original task")
          if (stage !== "timer") { await delay(90); assert.equal(entered, true) }
          const save = h.ctx.storage.set
          h.ctx.storage.set = async () => { h.ctx.storage.set = save; throw new Error("disk failure") }
          await assert.rejects(c.command("s1", action), /disk failure/)
          await delay(90)
          assert.equal(h.goal().status, "active")
          assert.equal(h.continuations().length, 0, "A failed stop must not restart automatically")
          await c.command("s1", "resume")
          await c.command("s1", "resume")
          await delay(90)
          assert.equal(h.continuations().length, 1)
          assert.match(h.continuations()[0].text, /<untrusted_objective>\noriginal task\n<\/untrusted_objective>/)
          await c.command("s1", "resume")
          await delay(90)
          assert.equal(h.continuations().length, 1, "Resume must not duplicate an accepted continuation")
        } finally { await c.close() }
      })
    }
  }
})

test("resume keeps an existing idle wait and never adds a duplicate", async () => {
  const h = host(), c = new GoalController(h.ctx)
  let waits = 0, release!: () => void
  h.ctx.session.wait = () => { waits++; return new Promise<void>(resolve => { release = resolve }) }
  await c.initialize()
  try {
    await c.command("s1", "work")
    await delay(90)
    await Promise.all([c.command("s1", "resume"), c.command("s1", "resume")])
    await delay(90)
    assert.equal(waits, 1)
    release()
    await delay(20)
    assert.equal(h.continuations().length, 1)
  } finally { release?.(); await c.close() }
})

test("a newer failed pause still prevents an older resume from scheduling", async () => {
  const h = host(), c = new GoalController(h.ctx)
  await c.initialize()
  let release!: () => void
  try {
    await c.command("s1", "work")
    await c.command("s1", "pause")
    const get = h.ctx.session.get
    let entered!: () => void
    const blocked = new Promise<void>(resolve => { entered = resolve })
    h.ctx.session.get = async (...args: any[]) => {
      h.ctx.session.get = get
      entered()
      await new Promise<void>(resolve => { release = resolve })
      return get(...args)
    }
    const resume = c.command("s1", "resume")
    await blocked
    const pause = c.command("s1", "pause")
    const save = h.ctx.storage.set
    let writes = 0
    h.ctx.storage.set = async (...args: any[]) => {
      if (++writes === 2) { h.ctx.storage.set = save; throw new Error("disk failure") }
      return save(...args)
    }
    const failed = assert.rejects(pause, /disk failure/)
    release()
    await Promise.all([resume, failed])
    await delay(90)
    assert.equal(h.continuations().length, 0)
    await c.command("s1", "resume")
    await delay(90)
    assert.equal(h.continuations().length, 1)
  } finally { release?.(); await c.close() }
})
