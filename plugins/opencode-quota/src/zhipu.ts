import { numeric, requestJSON, resetTime } from "./api.ts"
import { normalize, object, QuotaError, type QuotaData } from "./data.ts"

export const ZHIPU_USAGE_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
export const ZAI_USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit"

export function parseZhipu(value: unknown, title = "智谱 Coding Plan"): QuotaData {
  if (!object(value)) throw new QuotaError(`${title} 返回了无法识别的额度数据`)
  if (value.success === false || (value.code !== undefined && ![200, "200", 0, "0"].includes(value.code as number | string)))
    throw new QuotaError(`${title} 查询未成功，请检查连接和套餐状态`)
  const data = object(value.data) ? value.data : value
  if (!Array.isArray(data.limits)) throw new QuotaError(`${title} 未返回可用的额度窗口`)
  const items = data.limits.filter(raw => object(raw) && ["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(String(raw.type)))
    .map((raw, index) => {
      if (!object(raw)) throw new QuotaError(`${title} 返回了无效的额度数据`)
      const tool = raw.type === "TIME_LIMIT"
      // unit 3 = hours, 6 = weeks, 5 = months. Legacy token rows have no window metadata.
      const unit = raw.unit === undefined ? undefined : numeric(raw.unit, title)
      const count = raw.number === undefined ? undefined : numeric(raw.number, title)
      const period = unit === 3 && count && count > 0 ? `${count} 小时`
        : unit === 6 && count && count > 0 ? count === 1 ? "每周" : `${count} 周`
        : unit === 5 && count && count > 0 ? count === 1 ? "每月" : `${count} 个月`
        : unit === undefined && count === undefined ? tool ? "每月" : raw.type === "TOKENS_LIMIT" ? "5 小时" : undefined : undefined
      const label = tool ? `MCP（${period ?? "套餐额度"}）` : period ?? `套餐额度 ${index + 1}`
      const reset = resetTime(raw.nextResetTime, title)
      if (tool && raw.usage !== undefined && raw.currentValue !== undefined && numeric(raw.usage, title) > 0)
        return { label, used: numeric(raw.currentValue, title), limit: numeric(raw.usage, title), unit: "次", ...reset }
      let used: number
      if (raw.percentage !== undefined) used = numeric(raw.percentage, title)
      else {
        const current = numeric(raw.currentValue, title), total = numeric(raw.usage, title)
        if (current < 0 || total <= 0) throw new QuotaError(`${title} 返回了无效的额度数值`)
        used = current / total * 100
      }
      return { label, used, limit: 100, unit: "%", ...reset }
    })
  if (!items.length) throw new QuotaError(`${title} 未返回可用的额度窗口`)
  return normalize({ title, items })
}

export async function queryZhipu(key: string, signal: AbortSignal, region: "cn" | "global" = "cn",
  transport = globalThis.fetch): Promise<QuotaData> {
  const title = region === "cn" ? "智谱 Coding Plan" : "Z.AI Coding Plan"
  // The official monitor API takes the raw Coding Plan key, without a Bearer prefix.
  return parseZhipu(await requestJSON(region === "cn" ? ZHIPU_USAGE_URL : ZAI_USAGE_URL, key, title, signal, transport), title)
}
