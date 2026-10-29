import { createHash, randomUUID } from "node:crypto"
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { NO_GOAL, accounted, formatElapsed, formatGoalSummary, parseGoalCommand,
  renderContinuationPrompt, type GoalState, type GoalCommand } from "./core.ts"
import { loadLegacy, parseGoal } from "./state.ts"
import { GoalRPC } from "./rpc.ts"

type Context = Plugin.Context
type Stored = { goal: GoalState | null; revision: string; terminal?: string }
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
  private waiting = new Map<string, AbortController>()
  private waits = new Set<Promise<void>>()
  private intents = new Map<string, object>()
  private pendingCommands = new Map<string, number>()
  private pendingTerminals = new Map<string, Set<string>>()
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
      revision: typeof raw?.revision === "string" ? raw.revision : randomUUID(),
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

  private cancelPending(id: string) {
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    this.waiting.get(id)?.abort()
    this.waiting.delete(id)
  }

  private cancel(id: string) {
    this.cancelPending(id)
    this.continuing.delete(id)
    this.stagnant.delete(id)
  }

  private invalidate(id: string) {
    const intent = {}
    this.intents.set(id, intent)
    this.cancelPending(id)
    return intent
  }

  private async mutate(id: string, operation: Operation, intent?: object): Promise<string> {
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
        if (goal.status === "active") {
          // An unsuccessful pause/clear can leave durable state active after
          // cancelling local admission. Explicit resume repairs that state,
          // but must not queue another turn behind an accepted continuation.
          if (!this.continuing.has(id) && (!intent || this.intents.get(id) === intent)) this.schedule(id)
          return `Goal is active\n\n${formatGoalSummary(goal)}`
        }
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
    await this.save(id, { ...record, goal: next, revision: randomUUID() })
    this.cancel(id)
    if (next?.status === "active" && (!intent || this.intents.get(id) === intent)) this.schedule(id)
    return next ? `${message}\n\n${formatGoalSummary(next)}` : `${message}\n${NO_GOAL}`
  }

  private schedule(id: string) {
    if (this.disposed || this.timers.has(id) || this.waiting.has(id)) return
    // Let the terminal execution transition release its scheduler before admitting another turn.
    const timer = setTimeout(() => {
      this.timers.delete(id)
      this.waitForIdle(id)
    }, 50)
    timer.unref()
    this.timers.set(id, timer)
  }

  private waitForIdle(id: string) {
    const controller = new AbortController()
    this.waiting.set(id, controller)
    const signal = AbortSignal.any([controller.signal, this.abort.signal])
    // Never hold the session's serial queue while waiting: pause/clear, tools
    // and terminal events must remain able to run and cancel this admission.
    const pending = (async () => {
      try {
        await this.ctx.session.wait({ sessionID: id }, { signal })
        await this.serial(id, async () => {
          if (signal.aborted || this.waiting.get(id) !== controller) return
          await this.continue(id, signal)
        })
      } catch (error) {
        if (!signal.aborted) await this.fail(id, error, signal)
      } finally {
        if (this.waiting.get(id) === controller) this.waiting.delete(id)
      }
    })()
    this.waits.add(pending)
    void pending.finally(() => this.waits.delete(pending))
  }

  private async fail(id: string, error: unknown, signal: AbortSignal) {
    console.error("opencode-goal: continuation stopped", error)
    if (this.disposed) return
    await this.serial(id, async () => {
      if (signal.aborted || this.disposed) return
      this.cancel(id)
      const record = await this.load(id)
      if (record.goal?.status === "active") {
        await this.save(id, { ...record, goal: { ...accounted(record.goal), status: "paused", activeStartedAt: null } })
        await this.notice(id, "Goal paused because continuation failed. Use /goal resume after fixing the error.")
      }
    }).catch(error => console.error("opencode-goal: failed to save pause", error))
  }

  private async continue(id: string, signal: AbortSignal) {
    if (signal.aborted) return
    const record = await this.load(id)
    if (signal.aborted || record.goal?.status !== "active") return
    const session = await this.owned(id)
    if (signal.aborted || !session || session.revert) return
    // V2 keeps current model (including variant) and agent on the session itself.
    if (session.agent?.toLowerCase() === "plan" || session.model?.variant?.toLowerCase().includes("plan")) return
    const goal = accounted(record.goal)
    await this.save(id, { ...record, goal })
    if (signal.aborted) return
    this.usedTools.delete(id)
    await this.ctx.session.synthetic({ sessionID: id, resume: true, delivery: "queue",
      text: renderContinuationPrompt({ objective: goal.objective, revision: record.revision, timeUsedSeconds: goal.timeUsedSeconds,
        mode: (this.stagnant.get(id) ?? 0) >= 2 ? "recovery" : "normal" }),
      description: "Continue working toward the active goal",
      metadata: { goal: "continuation" } }, { signal })
    // Only acknowledged admissions count as running. An aborted submission
    // must not leave a stale marker that prevents explicit resume.
    this.continuing.add(id)
  }

  async command(id: string, text: string) {
    const operation = parseGoalCommand(text)
    // Invalidate before waiting for persistence or an in-flight admission.
    // A status query, invalid append, or resume must not stop the goal.
    const intent = operation.kind === "pause" || operation.kind === "clear" ||
      ((operation.kind === "set" || operation.kind === "append") && operation.objective.trim())
      ? this.invalidate(id) : operation.kind === "resume" ? {} : undefined
    if (operation.kind === "resume") this.intents.set(id, intent!)
    // A command can be waiting for storage while the previous request still
    // holds a valid tool snapshot. Do not let that tool cancel the new intent.
    if (intent) this.pendingCommands.set(id, (this.pendingCommands.get(id) ?? 0) + 1)
    return this.serial(id, async () => {
      try {
        if (!await this.owned(id)) throw new Error("Goal session belongs to another location")
        const goal = (await this.load(id)).goal
        const message = operation.kind === "show" ? goal ? formatGoalSummary(goal) : NO_GOAL : await this.mutate(id, operation, intent)
        await this.notice(id, message)
      } catch (error) {
        // A failed edit must not strand the previous active goal. A newer
        // pause, edit or user input owns scheduling and must win over recovery.
        if (intent && this.intents.get(id) === intent &&
          (operation.kind === "set" || operation.kind === "append") &&
          this.records.get(id)?.goal?.status === "active") this.schedule(id)
        throw error
      }
    }).finally(() => {
      if (!intent) return
      const remaining = (this.pendingCommands.get(id) ?? 1) - 1
      if (remaining) this.pendingCommands.set(id, remaining)
      else this.pendingCommands.delete(id)
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
    const terminalID = event.type.startsWith("session.execution.") ? event.id : undefined
    if (terminalID) {
      if (this.records.get(id)?.terminal === terminalID || this.pendingTerminals.get(id)?.has(terminalID)) return
      const pending = this.pendingTerminals.get(id) ?? new Set<string>()
      pending.add(terminalID)
      this.pendingTerminals.set(id, pending)
    }
    if (event.type === "session.deleted" || event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted" ||
      (event.type === "session.inbox.enqueued" && event.data.item?.type === "user")) this.invalidate(id)
    return this.serial(id, async () => {
      if (event.type === "session.deleted") {
        this.cancel(id)
        await this.save(id, { goal: null, revision: randomUUID() })
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
    }).finally(() => {
      if (!terminalID) return
      const pending = this.pendingTerminals.get(id)
      pending?.delete(terminalID)
      if (!pending?.size) this.pendingTerminals.delete(id)
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
      // OpenCode retains this executable snapshot for the model request.
      // Accounting checkpoints preserve revisions; goal changes replace them.
      const revisions = new Map([...this.records].filter(([, r]) => r.goal?.status === "active")
        .map(([id, r]) => [id, r.revision]))
      if (!revisions.size) return
      editor.add({ name: "update_goal",
        description: "Mark the active /goal complete only after verifying every requirement. Copy revision exactly from <goal_revision> in the goal continuation you verified; never guess it.",
        input: Schema.Struct({ status: Schema.Literal("complete"), revision: Schema.String }), options: { codemode: false },
        execute: async (input, context) => {
          const id = context.sessionID
          // A later model request may refresh tools before the new objective is
          // delivered. Only the continuation supplies its completion revision.
          const current = () => !this.disposed && !this.pendingCommands.has(id) && revisions.has(id) &&
            input.revision === revisions.get(id) &&
            this.records.get(id)?.goal?.status === "active" && this.records.get(id)?.revision === revisions.get(id)
          const stale = "Goal revision is missing or no longer current; completion ignored. Stop this turn without retrying update_goal. Wait for a fresh goal continuation before completing."
          if (!current()) return { content: stale }
          this.invalidate(id)
          return { content: await this.serial(id, async () => {
            if (!await this.owned(id)) return "No active goal to complete"
            if (!current()) return stale
            return this.mutate(id, { kind: "complete" })
          }) }
        } })
    })
    await this.ctx.session.hook("context", async input => {
      await this.serial(input.sessionID, async () => {
        if ((await this.load(input.sessionID)).goal?.status !== "active") delete input.tools.update_goal
      })
    })
    this.listener = (async () => {
      try {
        for await (const event of this.ctx.event.subscribe({ signal: this.abort.signal })) {
          // event() invalidates admission synchronously, then serializes state
          // changes itself. Do not block delivery of newer cancellation events.
          void this.event(event).catch(error => console.error("opencode-goal: event failed", error))
        }
      } catch (error) { if (!this.disposed) console.error("opencode-goal: event stream failed", error) }
    })()
  }

  async close() {
    this.disposed = true
    for (const id of this.timers.keys()) this.cancel(id)
    this.abort.abort()
    await Promise.allSettled([...this.waits])
    await this.listener
    await Promise.allSettled([...this.queues.values()])
    for (const [id, record] of this.records) {
      if (record.goal?.status === "active") await this.ctx.storage.set(this.prefix + id, { ...record, goal: accounted(record.goal) })
    }
  }
}
