import { QuotaError } from "./data.ts"

export function numeric(value: unknown, provider: string): number {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? Number(value) : NaN
  if (!Number.isFinite(parsed)) throw new QuotaError(`${provider} 返回了无效的额度数值`)
  return parsed
}

export function resetTime(value: unknown, provider: string): { resetsAt?: string } {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") return {}
  const timestamp = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value)
    : typeof value === "string" ? Date.parse(value) : NaN
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) throw new QuotaError(`${provider} 返回了无效的重置时间`)
  return { resetsAt: date.toISOString() }
}

export async function requestJSON(url: string, authorization: string, provider: string,
  signal: AbortSignal, transport = globalThis.fetch): Promise<unknown> {
  signal.throwIfAborted()
  let response: Response
  try {
    response = await transport(url, {
      method: "GET", headers: { Authorization: authorization, Accept: "application/json" },
      signal, redirect: "error",
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new QuotaError(`${provider} 额度查询网络异常`)
  }
  // Never echo upstream bodies or exception messages, which may contain secrets.
  if (response.status === 401) throw new QuotaError(`${provider} 凭据无效，请通过 /connect 检查连接`)
  if (response.status === 403) throw new QuotaError(`${provider} 拒绝访问，请检查账号权限或订阅`)
  if (response.status === 429) throw new QuotaError(`${provider} 额度查询过于频繁，请稍后刷新`)
  if (!response.ok) throw new QuotaError(`${provider} 额度查询失败（HTTP ${response.status}）`)
  try { return await response.json() } catch (error) {
    if (signal.aborted) throw error
    throw new QuotaError(`${provider} 额度接口返回了无效的 JSON`)
  }
}
