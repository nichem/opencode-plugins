export type Location = { directory: string; workspaceID?: string }
export type PanelState = { enabled?: boolean; busy: boolean; saving?: boolean; error?: string }
type Request = (enabled: boolean | undefined, location: Location, signal: AbortSignal) => Promise<{ enabled: boolean }>

export class BehaviorPanel {
  state: PanelState = { busy: false }
  private location?: Location
  private key = ""
  private generation = 0
  private pending?: AbortController
  private dirty = false
  private disposed = false
  private query: Request
  private update: (state: PanelState) => void
  private timeoutMs: number

  constructor(query: Request, update: (state: PanelState) => void, timeoutMs = 10000) {
    this.query = query
    this.update = update
    this.timeoutMs = timeoutMs
  }
  private publish(state: PanelState) { this.state = state; this.update(state) }

  select(location: Location) {
    const key = JSON.stringify([location.directory, location.workspaceID])
    if (this.disposed || this.key === key) return
    this.key = key
    this.location = { ...location }
    this.generation++
    this.pending?.abort()
    this.pending = undefined
    this.dirty = false
    this.publish({ busy: false })
    void this.refresh()
  }

  refresh() {
    if (this.pending) { this.dirty = true; return Promise.resolve() }
    return this.request()
  }

  toggle() {
    if (this.pending) return Promise.resolve()
    return this.state.enabled === undefined ? this.refresh() : this.request(!this.state.enabled)
  }

  private async request(enabled?: boolean) {
    if (this.disposed || !this.location) return
    const generation = this.generation
    const pending = new AbortController()
    this.pending = pending
    this.publish({ ...this.state, busy: true, saving: enabled !== undefined, error: undefined })
    const timer = setTimeout(() => pending.abort(new Error("Behavior request timed out")), this.timeoutMs)
    let stop = () => {}
    try {
      // Also settle locally when a disconnected transport ignores cancellation.
      const result = await new Promise<{ enabled: boolean }>((resolve, reject) => {
        const abort = () => reject(pending.signal.reason)
        pending.signal.addEventListener("abort", abort, { once: true })
        stop = () => pending.signal.removeEventListener("abort", abort)
        if (pending.signal.aborted) { abort(); return }
        this.query(enabled, this.location!, pending.signal).then(resolve, reject)
      })
      if (this.disposed || generation !== this.generation) return
      if (typeof result.enabled !== "boolean") throw new Error("Invalid behavior state")
      this.publish({ enabled: result.enabled, busy: false })
    } catch {
      if (!this.disposed && generation === this.generation)
        this.publish({ busy: false, error: enabled === undefined
          ? "读取失败，点击重试；请检查服务端插件"
          : "保存结果未确认，点击重新读取" })
    } finally {
      clearTimeout(timer)
      stop()
      if (this.pending === pending) {
        this.pending = undefined
        if (this.dirty) { this.dirty = false; void this.refresh() }
      }
    }
  }

  dispose() {
    this.disposed = true
    this.generation++
    this.pending?.abort()
    this.pending = undefined
  }
}
