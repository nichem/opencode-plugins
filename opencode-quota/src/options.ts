import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { object } from "./data.ts"

export type Options = { timeoutMs: number; providers: Map<string, string> }

export function milliseconds(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`opencode-quota: 时间参数须为 ${min} 至 ${max} 的整数毫秒数`)
  return value
}

export function options(raw: Record<string, unknown>, directory: string): Options {
  const timeoutMs = milliseconds(raw.timeoutMs, 10000, 1000, 60000)
  const providers = new Map<string, string>()
  if (raw.providers !== undefined) {
    if (!object(raw.providers)) throw new Error("opencode-quota: providers 须为对象")
    for (const [id, value] of Object.entries(raw.providers)) {
      if (!id.trim() || !object(value) || typeof value.script !== "string" || !value.script.trim())
        throw new Error("opencode-quota: providers 的每一项须包含 script 文件路径")
      const path = value.script.startsWith("~/") || value.script.startsWith("~\\")
        ? resolve(homedir(), value.script.slice(2)) : value.script
      if (!/\.(?:mjs|js)$/i.test(path)) throw new Error("opencode-quota: script 须为 .js 或 .mjs 文件")
      providers.set(id, isAbsolute(path) ? path : resolve(directory, path))
    }
  }
  return { timeoutMs, providers }
}
