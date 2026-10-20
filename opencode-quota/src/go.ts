import { normalize, object, QuotaError, type QuotaData } from "./data.ts"

export const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

// The official endpoint originally returned *Usage/usagePercent/resetInSec;
// the current inference backend returns usage.{rolling,weekly,monthly}.
export function parseGo(value: unknown, now = Date.now()): QuotaData {
  if (!object(value)) throw new QuotaError("OpenCode Go 返回了无法识别的额度数据")
  const usage = object(value.usage) ? value.usage : value
  const items = ([ ["rolling", "5 小时"], ["weekly", "每周"], ["monthly", "每月"] ] as const).map(([key, label]) => {
    const window = usage[key] ?? usage[`${key}Usage`]
    if (!object(window)) throw new QuotaError("OpenCode Go 返回了不完整的额度数据")
    const used = window.percent ?? window.usagePercent
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0)
      throw new QuotaError("OpenCode Go 返回了无效的使用率")
    const resetsAt = typeof window.resetsAt === "string" ? window.resetsAt
      : typeof window.resetInSec === "number" && Number.isFinite(window.resetInSec) && window.resetInSec >= 0
        ? new Date(now + window.resetInSec * 1000).toISOString() : undefined
    return { label, used, limit: 100, unit: "%", ...(resetsAt ? { resetsAt } : {}) }
  })
  return normalize({ title: "OpenCode Go", items })
}

export async function queryGo(key: string, signal: AbortSignal, transport = globalThis.fetch): Promise<QuotaData> {
  signal.throwIfAborted()
  let response: Response
  try {
    response = await transport(GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal, redirect: "error",
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new QuotaError("OpenCode Go 额度查询网络异常")
  }
  // Do not echo response bodies: an upstream error can contain credentials.
  if (response.status === 401) throw new QuotaError("Go 凭据无效，请通过 /connect 检查连接")
  if (response.status === 403) throw new QuotaError("当前账号没有可用的 Go 订阅")
  if (response.status === 429) throw new QuotaError("Go 额度查询过于频繁，请稍后刷新")
  if (!response.ok) throw new QuotaError(`Go 额度查询失败（HTTP ${response.status}）`)
  let value: unknown
  try { value = await response.json() } catch { throw new QuotaError("Go 额度接口返回了无效的 JSON") }
  return parseGo(value)
}
