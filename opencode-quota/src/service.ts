import type { Credential } from "@opencode/plugin"
import { builtins, QuotaEndpointError } from "./builtins.ts"
import { normalize, QuotaError, type QuotaData, type QuotaResult, type Selection } from "./data.ts"
import type { Options } from "./options.ts"
import { runScript } from "./script.ts"

export type Credentials = {
  // A model ID requires endpoint validation before resolving a built-in credential.
  resolve(providerID: string, modelID?: string): Promise<Credential.Value | undefined>
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
  })
}

export class QuotaService {
  private closed = new AbortController()
  constructor(privateOptions: Options, credentials: Credentials) {
    this.config = privateOptions
    this.credentials = credentials
  }
  private config: Options
  private credentials: Credentials

  close() { this.closed.abort() }

  async query(selection: Selection, requestSignal: AbortSignal): Promise<QuotaResult> {
    const script = this.config.providers.get(selection.providerID)
    const builtin = builtins.get(selection.providerID)
    if (!script && !builtin)
      return { ...selection, status: "unconfigured", items: [], message: "此供应商尚未配置额度脚本" }
    const signal = AbortSignal.any([requestSignal, this.closed.signal, AbortSignal.timeout(this.config.timeoutMs)])
    try {
      signal.throwIfAborted()
      const credential = await abortable(this.credentials.resolve(selection.providerID, script ? undefined : selection.modelID), signal)
      signal.throwIfAborted()
      let data: QuotaData
      if (script) data = normalize(await runScript(script, selection, credential, signal))
      else {
        const key = credential?.type === "key" ? credential.key
          : builtin?.oauth && credential?.type === "oauth" ? credential.access : undefined
        if (!builtin || !key?.trim()) throw new QuotaError(`请先通过 /connect 连接 ${builtin?.name ?? selection.providerID}`)
        data = await builtin.query(key, signal)
      }
      // Protect against scripts accidentally returning raw connection secrets.
      const secrets = credential?.type === "key" ? [credential.key]
        : credential?.type === "oauth" ? [credential.access, credential.refresh] : []
      const hide = (value: string) => secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("[已隐藏]"), value)
      // Redact string values only: a short/oddly-shaped secret must not change
      // JSON field names or invalidate the RPC payload.
      return { ...selection, ...data, ...(data.title === undefined ? {} : { title: hide(data.title) }),
        items: data.items.map(item => ({ ...item, label: hide(item.label),
          ...(item.value === undefined ? {} : { value: hide(item.value) }),
          ...(item.unit === undefined ? {} : { unit: hide(item.unit) }),
        })), status: "ready", updatedAt: Date.now() }
    } catch (error) {
      if (requestSignal.aborted || this.closed.signal.aborted) throw error
      return { ...selection, status: !signal.aborted && error instanceof QuotaEndpointError ? "unconfigured" : "error",
        items: [], message: signal.aborted ? "额度查询超时"
        : error instanceof QuotaError ? error.message : "额度查询失败，请检查供应商连接" }
    }
  }
}
