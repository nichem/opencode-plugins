export type Selection = { providerID: string; modelID: string }
export type QuotaItem = {
  label: string
  value?: string
  used?: number
  limit?: number
  unit?: string
  resetsAt?: string
}
export type QuotaData = { title?: string; items: readonly QuotaItem[] }
export type QuotaResult = Selection & QuotaData & {
  status: "ready" | "unconfigured" | "error"
  message?: string
  updatedAt?: number
}

export class QuotaError extends Error {}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown, max = 160): string {
  if (typeof value !== "string" || value.length > max) throw new QuotaError("额度数据格式不正确")
  const clean = value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim()
  if (!clean) throw new QuotaError("额度数据格式不正确")
  return clean
}

export function normalize(value: unknown): QuotaData {
  if (!object(value) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 12)
    throw new QuotaError("额度脚本须返回 1 至 12 项 items")
  return {
    ...(value.title === undefined ? {} : { title: text(value.title, 80) }),
    items: value.items.map(raw => {
      if (!object(raw)) throw new QuotaError("额度数据格式不正确")
      const item: QuotaItem = { label: text(raw.label, 80) }
      if (raw.value !== undefined) item.value = text(raw.value)
      if (raw.unit !== undefined) item.unit = text(raw.unit, 16)
      if (raw.used !== undefined || raw.limit !== undefined) {
        if (typeof raw.used !== "number" || !Number.isFinite(raw.used) || raw.used < 0
          || typeof raw.limit !== "number" || !Number.isFinite(raw.limit) || raw.limit <= 0)
          throw new QuotaError("额度 used 和 limit 必须是有效数值，limit 须大于 0")
        item.used = raw.used
        item.limit = raw.limit
      }
      if (item.value === undefined && item.used === undefined) throw new QuotaError("额度项缺少 value 或 used/limit")
      if (raw.resetsAt !== undefined) {
        if (typeof raw.resetsAt !== "string" || !Number.isFinite(Date.parse(raw.resetsAt)))
          throw new QuotaError("额度 resetsAt 须为日期时间字符串")
        item.resetsAt = new Date(raw.resetsAt).toISOString()
      }
      return item
    }),
  }
}

export function remaining(item: QuotaItem): number | undefined {
  if (item.used === undefined || item.limit === undefined) return
  return Math.max(0, Math.min(100, 100 - item.used / item.limit * 100))
}

export function formatValue(item: QuotaItem): string {
  if (item.value !== undefined) return item.value
  if (item.unit === "%") return `剩余 ${Math.round(remaining(item) ?? 0)}%`
  return `${item.used} / ${item.limit}${item.unit ? ` ${item.unit}` : ""}`
}

export function formatReset(resetsAt: string, now: number): string {
  const minutes = Math.ceil((Date.parse(resetsAt) - now) / 60000)
  if (minutes <= 0) return "等待重置"
  if (minutes < 60) return `${minutes} 分钟后重置`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}后重置`
  return `${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ""}后重置`
}
