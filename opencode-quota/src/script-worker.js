import { parentPort, workerData } from "node:worker_threads"
import { pathToFileURL } from "node:url"

const controller = new AbortController()
parentPort.on("message", message => { if (message === "abort") controller.abort() })
try {
  const module = await import(pathToFileURL(workerData.script).href)
  if (typeof module.default !== "function") throw new Error("missing default export")
  const data = await module.default({
    providerID: workerData.providerID,
    modelID: workerData.modelID,
    credential: workerData.credential,
    signal: controller.signal,
  })
  parentPort.postMessage({ ok: true, data })
} catch {
  // Never send arbitrary exception text or stack traces to the TUI or logs.
  parentPort.postMessage({ ok: false })
} finally {
  parentPort.close()
}
