import { Worker } from "node:worker_threads"
import { QuotaError, type Selection } from "./data.ts"

export function runScript(script: string, selection: Selection, credential: unknown, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./script-worker.js", import.meta.url), {
      workerData: { script, ...selection, credential }, stdout: true, stderr: true,
    })
    // User scripts must not accidentally print credentials into OpenCode logs.
    worker.stdout.resume()
    worker.stderr.resume()
    let settled = false
    const finish = (error?: unknown, data?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", abort)
      void worker.terminate().catch(() => {})
      if (error) reject(error)
      else resolve(data)
    }
    const abort = () => {
      worker.postMessage("abort")
      finish(signal.reason ?? new QuotaError("额度查询已取消"))
    }
    worker.on("message", message => {
      if (message?.ok === true) finish(undefined, message.data)
      else finish(new QuotaError("额度脚本执行失败，请检查脚本及 default 导出"))
    })
    worker.on("error", () => finish(new QuotaError("额度脚本加载失败，请检查路径及语法")))
    worker.on("exit", () => finish(new QuotaError("额度脚本退出，未返回数据")))
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}
