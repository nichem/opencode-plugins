import { createHash } from "node:crypto"
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { NO_GOAL, accounted, formatElapsed, formatGoalSummary, parseGoalCommand,
  renderContinuationPrompt, type GoalState, type GoalCommand } from "./core.ts"
import { loadLegacy, parseGoal } from "./state.ts"
import { GoalRPC } from "./rpc.ts"

type Context = Plugin.Context
type Stored = { goal: GoalState | null; terminal?: string }
type Operation = Exclude<GoalCommand, { kind: "show" }> | { kind: "complete" }
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16)

export default Plugin.define({
  id: "opencode-goal",
  async setup(ctx) {
    const controller = new GoalController(ctx)
    await controller.initialize()
    return () => controller.close()
  },
})

export class GoalController {
  private ctx: Context
  private prefix: string
  private records = new Map<string, Stored>()
  private legacy = new Map<string, GoalState>()
  private queues = new Map<string, Promise<unknown>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private continuing = new Set<string>()
  private usedTools = new Set<string>()
  private stagnant = new Map<string, number>()
  private abort = new AbortController()
  private listener?: Promise<void>
  private disposed = false
  private notify?: (id: string, message: string) => Promise<void>

  constructor(ctx: Context) {
    this.ctx = ctx
    this.prefix = `goals/${hash(JSON.stringify([ctx.location.directory, ctx.location.workspaceID ?? ""]))}/`
  }

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
    this.queues.set(id, next)
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id) }).catch(() => {})
    return next
  }

  private async owned(id: string) {
    const session = await this.ctx.session.get({ sessionID: id })
    // Public session info exposes directory only; workspace is checked on event envelopes.
    return session.location.directory === this.ctx.location.directory ? session : undefined
  }

  private async load(id: string): Promise<Stored> {
    const existing = this.records.get(id)
    if (existing) return existing
    const raw = await this.ctx.storage.get(this.prefix + id) as Stored | undefined
    const goal = raw ? parseGoal(raw.goal) : this.legacy.get(id)
    const record: Stored = { goal: goal ? { ...goal, activeStartedAt: goal.status === "active" ? Date.now() : null } : null,
      ...(typeof raw?.terminal === "string" ? { terminal: raw.terminal } : {}) }
    this.records.set(id, record)
    if (goal) await this.save(id, record)
    return record
  }

  private async save(id: string, record: Stored) {
    // Commit storage before exposing a mutation or scheduling more work.
    await this.ctx.storage.set(this.prefix + id, record)
    this.records.set(id, record)
    await this.ctx.tool.reload()
  }

  private async notice(id: string, text: string) {
    await this.notify?.(id, text)
  }

  private cancel(id: string) {
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    this.continuing.delete(id)
    this.stagnant.delete(id)
  }

  private async mutate(id: string, operation: Operation): Promise<string> {
    const record = await this.load(id)
    const goal = record.goal
    const now = Date.now()
    let next: GoalState | null = goal
    let message: string
    const activate = (g: GoalState, objective = g.objective): GoalState => ({ ...g, objective,
      status: "active", activeStartedAt: g.status === "active" ? g.activeStartedAt : now, updatedAt: now })
    switch (operation.kind) {
      case "set": {
        const objective = operation.objective.trim()
        if (!objective) return "Usage: /goal <objective>"
        next = goal ? activate(goal, objective) : { objective, status: "active", createdAt: now, updatedAt: now,
          activeStartedAt: now, timeUsedSeconds: 0 }
        message = goal ? "Goal updated" : "Goal active"
        break
      }
      case "append":
        if (!operation.objective.trim()) return "Usage: /goal append <text>"
        if (!goal) return "No goal to append"
        next = activate(goal, `${goal.objective}\n${operation.objective.trim()}`)
        message = "Goal appended"
        break
      case "resume":
        if (!goal) return "No goal to resume"
        if (goal.status === "active") return "Goal is active"
        next = activate(goal)
        message = "Goal active"
        break
      case "pause":
        if (!goal) return "No goal to pause"
        if (goal.status !== "active") return `Goal is ${goal.status}`
        next = { ...accounted(goal, now), status: "paused", activeStartedAt: null, updatedAt: now }
        message = "Goal paused"
        break
      case "clear":
        next = null
        message = goal ? "Goal cleared" : "No goal to clear"
        break
      case "complete":
        if (!goal || goal.status !== "active") return "No active goal to complete"
        next = { ...accounted(goal, now), status: "complete", activeStartedAt: null, updatedAt: now }
        message = `Goal complete. Final elapsed time: ${formatElapsed(next.timeUsedSeconds)}.`
        break
    }
    await this.save(id, { ...record, goal: next })
    this.cancel(id)
    if (next?.status === "active") this.schedule(id)
    return next ? `${message}\n\n${formatGoalSummary(next)}` : `${message}\n${NO_GOAL}`
  }

  private schedule(id: string) {
    if (this.disposed || this.timers.has(id)) return
    // Let the terminal execution transition release its scheduler before admitting another turn.
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.serial(id, () => this.continue(id)).catch(error => this.fail(id, error))
    }, 50)
    timer.unref()
    this.timers.set(id, timer)
  }

  private async fail(id: string, error: unknown) {
    console.error("opencode-goal: continuation stopped", error)
    if (this.disposed) return
    await this.serial(id, async () => {
      this.cancel(id)
      const record = await this.load(id)
      if (record.goal?.status === "active") {
        await this.save(id, { ...record, goal: { ...accounted(record.goal), status: "paused", activeStartedAt: null } })
        await this.notice(id, "Goal paused because continuation failed. Use /goal resume after fixing the error.")
      }
    }).catch(error => console.error("opencode-goal: failed to save pause", error))
  }

  private async continue(id: string) {
    if (this.disposed) return
    const record = await this.load(id)
    if (record.goal?.status !== "active") return
    const session = await this.owned(id)
    if (!session || this.disposed) return
    // V2 keeps current model (including variant) and agent on the session itself.
    if (session.agent?.toLowerCase() === "plan" || session.model?.variant?.toLowerCase().includes("plan")) return
    const goal = accounted(record.goal)
    await this.save(id, { ...record, goal })
    if (this.disposed) return
    this.continuing.add(id)
    this.usedTools.delete(id)
    await this.ctx.session.synthetic({ sessionID: id, resume: true, delivery: "queue",
      text: renderContinuationPrompt({ objective: goal.objective, timeUsedSeconds: goal.timeUsedSeconds,
        mode: (this.stagnant.get(id) ?? 0) >= 2 ? "recovery" : "normal" }),
      description: "Continue working toward the active goal",
      metadata: { goal: "continuation" } }, { signal: this.abort.signal })
  }

  async command(id: string, text: string) {
    return this.serial(id, async () => {
      if (!await this.owned(id)) throw new Error("Goal session belongs to another location")
      const operation = parseGoalCommand(text)
      const goal = (await this.load(id)).goal
      const message = operation.kind === "show" ? goal ? formatGoalSummary(goal) : NO_GOAL : await this.mutate(id, operation)
      await this.notice(id, message)
    })
  }

  async event(event: { type: string; id?: string; location?: { directory: string; workspaceID?: string }; data?: any }) {
    const id = event.data?.sessionID
    if (typeof id !== "string" || this.disposed) return
    if (event.location && (event.location.directory !== this.ctx.location.directory
      || (event.location.workspaceID ?? "") !== (this.ctx.location.workspaceID ?? ""))) return
    const relevant = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
      "session.tool.called", "session.deleted", "session.inbox.enqueued"]
    if (!relevant.includes(event.type)) return
    return this.serial(id, async () => {
      if (event.type === "session.deleted") {
        this.cancel(id)
        await this.save(id, { goal: null })
        return
      }
      if (!await this.owned(id)) return
      const record = await this.load(id)
      if (record.goal?.status !== "active") return
      if (event.type === "session.inbox.enqueued") {
        if (event.data.item?.type === "user") this.cancel(id)
        return
      }
      if (event.type === "session.tool.called") { this.usedTools.add(id); return }
      if (event.id && record.terminal === event.id) return
      const terminal = event.id ? { terminal: event.id } : {}
      if (event.type !== "session.execution.succeeded") {
        this.cancel(id)
        // Shutdown should preserve active state, without charging offline time.
        const status = event.type === "session.execution.interrupted" && event.data.reason === "shutdown" ? "active" : "paused"
        const goal = accounted(record.goal)
        await this.save(id, { ...record, ...terminal, goal: { ...goal, status, activeStartedAt: status === "active" ? goal.activeStartedAt : null } })
        if (status === "paused") await this.notice(id, "Goal paused after interruption or execution error. Use /goal resume to continue.")
        return
      }
      if (this.continuing.delete(id)) {
        this.stagnant.set(id, this.usedTools.has(id) ? 0 : (this.stagnant.get(id) ?? 0) + 1)
      }
      this.usedTools.delete(id)
      await this.save(id, { ...record, ...terminal, goal: accounted(record.goal) })
      this.schedule(id)
    })
  }

  async initialize() {
    this.legacy = await loadLegacy(this.ctx.location.project.canonical)
    let after: string | undefined
    do {
      const page = await this.ctx.storage.scan({ prefix: this.prefix, ...(after ? { after } : {}) })
      for (const entry of page.entries) await this.load(entry.key.slice(this.prefix.length))
      after = page.next
    } while (after)
    const rpc = await this.ctx.rpc.register(GoalRPC, {
      status: async input => {
        const { sessionID } = input as { sessionID: string }
        return this.serial(sessionID, async () => {
          if (!await this.owned(sessionID)) throw new Error("Goal session belongs to another location")
          const goal = (await this.load(sessionID)).goal
          return { summary: goal ? formatGoalSummary(goal) : NO_GOAL }
        })
      },
    })
    this.notify = (sessionID, message) => rpc.events.emit("notice", { sessionID, message })
    await this.ctx.command.transform(editor => editor.add({ name: "goal",
      description: "Set, append, pause, resume, clear or view a persistent goal",
      execute: input => this.command(input.sessionID, input.prompt.text) }))
    await this.ctx.tool.transform(editor => {
      if (![...this.records.values()].some(r => r.goal?.status === "active")) return
      editor.add({ name: "update_goal", description: "Mark the active /goal complete only after verifying every requirement.",
        input: Schema.Struct({ status: Schema.Literal("complete") }), options: { codemode: false },
        execute: async (_input, context) => ({ content: await this.serial(context.sessionID, async () => {
          if (!await this.owned(context.sessionID)) return "No active goal to complete"
          return this.mutate(context.sessionID, { kind: "complete" })
        }) }) })
    })
    await this.ctx.session.hook("context", async input => {
      await this.serial(input.sessionID, async () => {
        if ((await this.load(input.sessionID)).goal?.status !== "active") delete input.tools.update_goal
      })
    })
    this.listener = (async () => {
      try {
        for await (const event of this.ctx.event.subscribe({ signal: this.abort.signal })) {
          try { await this.event(event) } catch (error) { console.error("opencode-goal: event failed", error) }
        }
      } catch (error) { if (!this.disposed) console.error("opencode-goal: event stream failed", error) }
    })()
  }

  async close() {
    this.disposed = true
    for (const id of this.timers.keys()) this.cancel(id)
    this.abort.abort()
    await this.listener
    await Promise.allSettled([...this.queues.values()])
    for (const [id, record] of this.records) {
      if (record.goal?.status === "active") await this.ctx.storage.set(this.prefix + id, { ...record, goal: accounted(record.goal) })
    }
  }
}
