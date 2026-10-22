import { QuotaError, type QuotaData } from "./data.ts"
import { queryDeepSeek } from "./deepseek.ts"
import { queryGo } from "./go.ts"
import { queryKimi } from "./kimi.ts"
import { queryZhipu } from "./zhipu.ts"

type Builtin = {
  name: string
  origin: string
  defaultPackages?: readonly string[]
  oauth?: boolean
  query(key: string, signal: AbortSignal): Promise<QuotaData>
}
const kimiCN: Builtin = { name: "Kimi For Coding", origin: "https://api.kimi.com", oauth: true,
  query: (key, signal) => queryKimi(key, signal) }

// Match exact OpenCode provider IDs; never try another region with the same credential.
export const builtins: ReadonlyMap<string, Builtin> = new Map([
  ["opencode-go", { name: "OpenCode Go", origin: "https://opencode.ai", oauth: true,
    defaultPackages: ["@opencode/ai/providers/opencode"], query: queryGo }],
  ["deepseek", { name: "DeepSeek", origin: "https://api.deepseek.com",
    defaultPackages: ["@opencode/ai/providers/deepseek"], query: queryDeepSeek }],
  ["zhipuai-coding-plan", { name: "智谱 Coding Plan", origin: "https://open.bigmodel.cn",
    query: (key, signal) => queryZhipu(key, signal) }],
  ["zai-coding-plan", { name: "Z.AI Coding Plan", origin: "https://api.z.ai",
    defaultPackages: ["", "/chat", "/messages", "/responses"].map(path => `@opencode/ai/providers/zai-coding-plan${path}`),
    query: (key, signal) => queryZhipu(key, signal, "global") }],
  ["kimi-for-coding", kimiCN],
  ["kimi-code-plan-cn", kimiCN],
  ["kimi-code-plan-global", { name: "Kimi For Coding", origin: "https://api.kimi.ai", oauth: true,
    query: (key, signal) => queryKimi(key, signal, "global") }],
])

type Endpoint = { package?: string; settings?: Record<string, unknown> }

export function allowsBuiltin(providerID: string, provider: Endpoint, model: Endpoint & { variants?: readonly Endpoint[] }): boolean {
  const builtin = builtins.get(providerID)
  if (!builtin) return false
  const baseURL = model.settings?.baseURL !== undefined ? model.settings.baseURL : provider.settings?.baseURL
  const packageName = model.package ?? provider.package
  const allowed = (value: unknown) => {
    // Without an explicit URL, only a known official runtime has a verifiable default.
    if (value === undefined) return builtin.defaultPackages?.includes(packageName ?? "") === true
    if (typeof value !== "string") return false
    try {
      const url = new URL(value)
      return url.origin === builtin.origin && !url.username && !url.password
    } catch { return false }
  }
  if (!allowed(baseURL)) return false
  // The RPC has no selected variant; reject models whose variants could route elsewhere.
  return (model.variants ?? []).every(variant => allowed(variant.settings?.baseURL !== undefined ? variant.settings.baseURL : baseURL))
}

export class QuotaEndpointError extends QuotaError {
  constructor() { super("此模型或其变体使用自定义或无法确认的接口，请配置额度脚本") }
}
