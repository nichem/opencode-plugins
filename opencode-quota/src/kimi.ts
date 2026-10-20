import { numeric, requestJSON, resetTime } from "./api.ts"
import { normalize, object, QuotaError, remaining, type QuotaData, type QuotaItem } from "./data.ts"

export const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages"
export const KIMI_GLOBAL_USAGE_URL = "https://api.kimi.ai/coding/v1/usages"
const title = "Kimi For Coding"

function legacyItem(raw: Record<string, unknown>, label: string): QuotaItem {
  const limit = numeric(raw.limit, title)
  const used = raw.used !== undefined ? numeric(raw.used, title) : limit - numeric(raw.remaining, title)
  if (limit <= 0 || used < 0) throw new QuotaError(`${title} 返回了无效的额度数值`)
  return { label, used, limit, unit: "%", ...resetTime(raw.resetTime, title) }
}

function windowLabel(raw: unknown, index: number): [string, string] {
  if (!object(raw)) return [`other-${index}`, `额度窗口 ${index + 1}`]
  const duration = numeric(raw.duration, title)
  if (duration <= 0) throw new QuotaError(`${title} 返回了无效的额度窗口`)
  const unit = String(raw.timeUnit).replace(/^TIME_UNIT_/, "")
  const seconds = duration * ({ SECOND: 1, MINUTE: 60, HOUR: 3600, DAY: 86400, WEEK: 604800 }[unit] ?? NaN)
  if (seconds === 18000) return ["rolling", "5 小时"]
  if (seconds === 604800) return ["weekly", "每周"]
  if (unit === "MONTH" && duration === 1) return ["monthly", "每月总额度"]
  const suffix = { SECOND: "秒", MINUTE: "分钟", HOUR: "小时", DAY: "天", WEEK: "周", MONTH: "个月" }[unit]
  return [`other-${index}`, suffix ? `${duration} ${suffix}` : `额度窗口 ${index + 1}`]
}

export function parseKimi(value: unknown): QuotaData {
  if (!object(value)) throw new QuotaError(`${title} 返回了无法识别的额度数据`)
  const data = object(value.data) ? value.data : value
  const windows = new Map<string, QuotaItem>()
  // Current official Kimi Code reads these ratio pools. Keep absent windows absent.
  if (object(data.usages)) for (const [field, key, label] of [
    ["limit_5h", "rolling", "5 小时"], ["limit_7d", "weekly", "每周"],
    ["limit_month_total", "monthly", "每月总额度"], ["limit_month_code", "monthly-code", "每月 Coding"],
  ]) {
    const raw = data.usages[field]
    if (raw === undefined) continue
    if (!object(raw)) throw new QuotaError(`${title} 返回了无效的额度窗口`)
    windows.set(key, { label, used: numeric(raw.used_ratio, title) * 100, limit: 100, unit: "%",
      ...resetTime(raw.reset_time, title) })
  }
  const addLegacy = (key: string, raw: Record<string, unknown>, label: string) => {
    const current = windows.get(key)
    if (!current) { windows.set(key, legacyItem(raw, label)); return }
    let legacy: QuotaItem
    try { legacy = legacyItem(raw, label) } catch (error) {
      // Unusable deprecated fields cannot invalidate a complete current ratio pool.
      if (error instanceof QuotaError) return
      throw error
    }
    // Reset timestamps can differ by seconds due to upstream rounding. Clearly
    // different cycles are not competing measurements of the same window.
    if (current.resetsAt && legacy.resetsAt
      && Math.abs(Date.parse(current.resetsAt) - Date.parse(legacy.resetsAt)) > 60000) return
    // Allow one percentage point for rounding, but never silently prefer a
    // zero ratio over an exhausted count-based pool (or the inverse).
    if (Math.abs(remaining(current)! - remaining(legacy)!) > 1 + 1e-9)
      throw new QuotaError(`${title} 同一额度窗口的新旧数据不一致，请稍后刷新`)
  }
  // Older accounts return count-based usage + limits. Compare overlapping pools
  // before falling back, rather than hiding a contradictory exhaustion signal.
  if (object(data.usage)) addLegacy("weekly", data.usage, "每周")
  if (Array.isArray(data.limits)) data.limits.forEach((raw, index) => {
    if (!object(raw)) throw new QuotaError(`${title} 返回了无效的额度窗口`)
    const [key, label] = windowLabel(raw.window, index)
    addLegacy(key, object(raw.detail) ? raw.detail : raw, label)
  })
  if (!windows.size) throw new QuotaError(`${title} 未返回可用的订阅额度`)
  const order = ["rolling", "weekly", "monthly", "monthly-code"]
  return normalize({ title, items: [
    ...order.flatMap(key => windows.has(key) ? [windows.get(key)!] : []),
    ...[...windows].filter(([key]) => !order.includes(key)).map(([, item]) => item),
  ] })
}

export async function queryKimi(key: string, signal: AbortSignal, region: "cn" | "global" = "cn",
  transport = globalThis.fetch): Promise<QuotaData> {
  return parseKimi(await requestJSON(region === "cn" ? KIMI_USAGE_URL : KIMI_GLOBAL_USAGE_URL, `Bearer ${key}`, title, signal, transport))
}
