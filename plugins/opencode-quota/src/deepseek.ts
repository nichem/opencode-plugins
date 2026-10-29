import { numeric, requestJSON } from "./api.ts"
import { normalize, object, QuotaError, type QuotaData } from "./data.ts"

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance"

export function parseDeepSeek(value: unknown): QuotaData {
  if (!object(value) || !Array.isArray(value.balance_infos) || !value.balance_infos.length)
    throw new QuotaError("DeepSeek 返回了无法识别的余额数据")
  return normalize({ title: "DeepSeek", items: value.balance_infos.flatMap(raw => {
    if (!object(raw) || !["CNY", "USD"].includes(String(raw.currency)))
      throw new QuotaError("DeepSeek 返回了无法识别的币种")
    return ([ ["total_balance", "可用余额"], ["granted_balance", "赠送余额"], ["topped_up_balance", "充值余额"] ] as const)
      .filter(([key]) => key === "total_balance" || raw[key] !== undefined)
      .map(([key, label]) => {
        numeric(raw[key], "DeepSeek")
        return { label: `${label}（${raw.currency}）`, value: `${raw.currency === "CNY" ? "¥" : "$"}${raw[key]}` }
      })
  }) })
}

export async function queryDeepSeek(key: string, signal: AbortSignal, transport = globalThis.fetch): Promise<QuotaData> {
  return parseDeepSeek(await requestJSON(DEEPSEEK_BALANCE_URL, `Bearer ${key}`, "DeepSeek", signal, transport))
}
