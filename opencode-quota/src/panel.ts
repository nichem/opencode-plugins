import type { QuotaResult, Selection } from "./data.ts"

export type PanelState = {
  selection?: Selection
  result?: QuotaResult
  loading: boolean
  error?: string
}

type Query = (selection: Selection, signal: AbortSignal) => Promise<QuotaResult>

export class QuotaPanel {
  state: PanelState = { loading: false }
  private query: Query
  private update: (state: PanelState) => void
  private key = ""
  private generation = 0
  private pending?: AbortController
  private timer?: ReturnType<typeof setInterval>
  private requestTimeoutMs: number
  private disposed = false

  constructor(query: Query, update: (state: PanelState) => void, refreshMs: number, requestTimeoutMs = 15000) {
    this.query = query
    this.update = update
    this.requestTimeoutMs = requestTimeoutMs
    if (refreshMs > 0) this.timer = setInterval(() => { void this.refresh() }, refreshMs)
  }

  private publish(state: PanelState) { this.state = state; this.update(state) }

  select(selection: Selection | undefined, scope = "") {
    const key = selection ? JSON.stringify([scope, selection.providerID, selection.modelID]) : ""
    if (this.disposed || key === this.key) return
    this.key = key
    this.generation++
    this.pending?.abort()
    this.pending = undefined
    // Never show the previous model/provider/account's data under a new label.
    this.publish({ selection, loading: false })
    void this.refresh()
  }

  invalidate() {
    if (this.disposed || !this.state.selection) return
    this.generation++
    this.pending?.abort()
    this.pending = undefined
    this.publish({ selection: this.state.selection, loading: false })
    void this.refresh()
  }

  async refresh() {
    const selection = this.state.selection
    if (this.disposed || !selection || this.pending) return
    const generation = this.generation
    const pending = new AbortController()
    this.pending = pending
    this.publish({ ...this.state, loading: true })
    let timedOut = false
    let stopAbort = () => {}
    const timeout = setTimeout(() => {
      timedOut = true
      pending.abort(new DOMException("Quota request timed out", "TimeoutError"))
    }, this.requestTimeoutMs)
    try {
      // Settle locally even if the transport ignores the abort signal or
      // cannot deliver the server's timeout response across a broken link.
      const result = await new Promise<QuotaResult>((resolve, reject) => {
        const abort = () => reject(pending.signal.reason)
        pending.signal.addEventListener("abort", abort, { once: true })
        stopAbort = () => pending.signal.removeEventListener("abort", abort)
        if (pending.signal.aborted) { abort(); return }
        this.query(selection, pending.signal).then(resolve, reject)
      })
      if (this.disposed || generation !== this.generation) return
      if (result.providerID !== selection.providerID || result.modelID !== selection.modelID)
        throw new Error("Mismatched quota result")
      if (result.status === "error") {
        this.publish({ ...this.state, loading: false, error: result.message ?? "额度查询失败" })
      } else {
        this.publish({ selection, result, loading: false })
      }
    } catch {
      if (!this.disposed && generation === this.generation)
        this.publish({ ...this.state, loading: false, error: timedOut
          ? "额度请求超时，请稍后刷新" : "无法获取额度，请检查服务端插件状态" })
    } finally {
      clearTimeout(timeout)
      stopAbort()
      if (this.pending === pending) this.pending = undefined
    }
  }

  dispose() {
    this.disposed = true
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.pending?.abort()
    this.pending = undefined
  }
}
