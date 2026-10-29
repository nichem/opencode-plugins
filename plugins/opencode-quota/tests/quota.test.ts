import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { normalize, formatReset, formatValue, remaining, type QuotaResult } from "../src/data.ts"
import { GO_USAGE_URL, parseGo, queryGo } from "../src/go.ts"
import { options } from "../src/options.ts"
import { QuotaPanel } from "../src/panel.ts"
import { QuotaService } from "../src/service.ts"

const selection = { providerID: "fixture", modelID: "one" }
const credential = { type: "key" as const, key: "fixture-secret-only" }
const ready = (providerID = "fixture", modelID = "one"): QuotaResult => ({
  providerID, modelID, status: "ready", title: providerID, items: [{ label: "余额", value: "$20" }], updatedAt: 1,
})
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

async function scriptFixture(source: string, run: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-test-"))
  try {
    const path = join(root, "quota.mjs")
    await writeFile(path, source)
    await run(path)
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
}

test("Go parses current server percentages and absolute reset times without estimating dollar limits", () => {
  const resetsAt = "2026-10-20T12:00:00Z"
  const data = parseGo({ usage: Object.fromEntries(["rolling", "weekly", "monthly"].map((key, i) =>
    [key, { status: "ok", percent: i * 50, resetsAt }])) })
  assert.equal(data.title, "OpenCode Go")
  assert.deepEqual(data.items.map(item => [item.used, item.limit, item.resetsAt]), [0, 50, 100].map(value =>
    [value, 100, "2026-10-20T12:00:00.000Z"]))
})

test("Go supports the original official response and does not invent zero for missing windows", () => {
  const window = { usagePercent: 108, resetInSec: 3600, status: "rate-limited" }
  const data = parseGo({ rollingUsage: window, weeklyUsage: window, monthlyUsage: window }, 0)
  assert.equal(data.items[0].resetsAt, "1970-01-01T01:00:00.000Z")
  assert.equal(formatValue(data.items[0]), "剩余 0%")
  assert.throws(() => parseGo({ usage: {} }), /不完整/)
  assert.throws(() => parseGo({ usage: { rolling: { percent: -1 } } }), /无效/)
})

test("Go sends the key to the fixed official usage URL only and disables redirects", async () => {
  const transport: typeof fetch = async (input, init) => {
    assert.equal(input, GO_USAGE_URL)
    assert.equal(init?.redirect, "error")
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${credential.key}`)
    return Response.json({ usage: Object.fromEntries(["rolling", "weekly", "monthly"].map(key => [key, { percent: 12 }])) })
  }
  assert.equal((await queryGo(credential.key, new AbortController().signal, transport)).items.length, 3)
  await assert.rejects(queryGo(credential.key, new AbortController().signal,
    async () => new Response(credential.key, { status: 401 })), error => {
    assert.match(String(error), /凭据无效/)
    assert.ok(!String(error).includes(credential.key))
    return true
  })
})

test("custom items support text and numeric quotas, reject malformed/oversized results, and strip terminal escapes", () => {
  const data = normalize({ items: [{ label: "\x1b[31m余额\x1b[0m", value: "$20\nUSD" }, { label: "每月", used: 8, limit: 10, unit: "次" }] })
  assert.deepEqual(data.items[0], { label: "余额", value: "$20 USD" })
  assert.equal(formatValue(data.items[1]), "8 / 10 次")
  assert.equal(remaining(data.items[1]), 20)
  for (const value of [{ items: [] }, { items: [{ label: "bad", used: 0, limit: 0 }] },
    { items: [{ label: "bad", used: NaN, limit: 100 }] }, { items: [{ label: "bad", value: "x", resetsAt: "tomorrow" }] },
    { items: Array.from({ length: 13 }, () => ({ label: "x", value: "y" })) }]) assert.throws(() => normalize(value))
  assert.equal(formatReset("1970-01-01T01:01:00Z", 0), "1 小时 1 分后重置")
  assert.equal(formatReset("1970-01-01T00:00:00Z", 1), "等待重置")
})

test("unconfigured providers do not read credentials or make requests", async () => {
  const service = new QuotaService({ timeoutMs: 1000, providers: new Map() }, { resolve: async () => assert.fail("unexpected credential read") })
  const result = await service.query(selection, new AbortController().signal)
  assert.equal(result.status, "unconfigured")
  service.close()
})

test("built-in provider IDs resolve only their own connection and route to the correct official endpoint", async t => {
  const fixtures = [
    ["deepseek", "https://api.deepseek.com/user/balance", { balance_infos: [{ currency: "CNY", total_balance: "1.00" }] }],
    ["zhipuai-coding-plan", "https://open.bigmodel.cn/api/monitor/usage/quota/limit", { limits: [{ type: "TOKENS_LIMIT", percentage: 25 }] }],
    ["zai-coding-plan", "https://api.z.ai/api/monitor/usage/quota/limit", { limits: [{ type: "CREDIT_LIMIT", percentage: 25 }] }],
    ["kimi-for-coding", "https://api.kimi.com/coding/v1/usages", { usages: { limit_5h: { used_ratio: 0.25 } } }],
    ["kimi-code-plan-cn", "https://api.kimi.com/coding/v1/usages", { usages: { limit_5h: { used_ratio: 0.25 } } }],
    ["kimi-code-plan-global", "https://api.kimi.ai/coding/v1/usages", { usages: { limit_5h: { used_ratio: 0.25 } } }],
  ] as const
  let expected: readonly [string, string, unknown]
  const calls: string[] = []
  const fetch = t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, expected[1])
    return Response.json(expected[2])
  })
  const service = new QuotaService({ timeoutMs: 1000, providers: new Map() }, {
    resolve: async id => { calls.push(id); return credential },
  })
  try {
    for (const fixture of fixtures) {
      expected = fixture
      const result = await service.query({ providerID: fixture[0], modelID: "fixture-model" }, new AbortController().signal)
      assert.equal(result.status, "ready", result.message)
      assert.equal(result.providerID, fixture[0])
      assert.equal(result.modelID, "fixture-model")
      assert.ok(!JSON.stringify(result).includes(credential.key))
    }
    assert.deepEqual(calls, fixtures.map(([id]) => id))
    assert.equal(fetch.mock.callCount(), fixtures.length)
    for (const providerID of ["zhipuai", "zai", "moonshotai", "moonshotai-cn", "not-deepseek"])
      assert.equal((await service.query({ providerID, modelID: "one" }, new AbortController().signal)).status, "unconfigured")
    assert.equal(calls.length, fixtures.length)
  } finally { service.close() }
})

test("missing built-in credentials produce a connect hint without sending network requests", async t => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Unexpected network request"))
  const service = new QuotaService({ timeoutMs: 1000, providers: new Map() }, { resolve: async () => undefined })
  try {
    for (const providerID of ["opencode-go", "deepseek", "zhipuai-coding-plan", "zai-coding-plan", "kimi-for-coding", "kimi-code-plan-cn", "kimi-code-plan-global"]) {
      const result = await service.query({ providerID, modelID: "one" }, new AbortController().signal)
      assert.equal(result.status, "error")
      assert.match(result.message!, /\/connect/)
      assert.ok(result.message!.includes(providerID === "deepseek" ? "DeepSeek" : providerID.startsWith("kimi") ? "Kimi" : providerID === "opencode-go" ? "Go" : "Coding Plan"))
    }
  } finally { service.close() }
})

test("Kimi accepts a saved OAuth access token without refreshing it or sharing it with other built-ins", async t => {
  const oauth = { type: "oauth" as const, access: "fixture-oauth-access", refresh: "fixture-oauth-refresh", expires: Date.now() + 60000 }
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.kimi.com/coding/v1/usages")
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${oauth.access}`)
    return Response.json({ usages: { limit_5h: { used_ratio: 0.25 } } })
  })
  const service = new QuotaService({ timeoutMs: 1000, providers: new Map() }, { resolve: async () => oauth })
  try {
    assert.equal((await service.query({ providerID: "kimi-for-coding", modelID: "one" }, new AbortController().signal)).status, "ready")
    for (const providerID of ["deepseek", "zhipuai-coding-plan", "zai-coding-plan"])
      assert.equal((await service.query({ providerID, modelID: "one" }, new AbortController().signal)).status, "error")
    assert.equal(fetch.mock.callCount(), 1)
  } finally { service.close() }
})

test("OpenCode Go accepts the Console OAuth token without enabling it for key-only built-ins", async t => {
  const oauth = { type: "oauth" as const, access: "fixture-go-oauth-access", refresh: "fixture-go-oauth-refresh", expires: Date.now() + 60000 }
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, GO_USAGE_URL)
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${oauth.access}`)
    return Response.json({ usage: {
      rolling: { percent: 10, resetsAt: "2026-11-01T00:00:00Z" },
      weekly: { percent: 20 },
      monthly: { percent: 30 },
    } })
  })
  const service = new QuotaService({ timeoutMs: 1000, providers: new Map() }, { resolve: async () => oauth })
  try {
    const result = await service.query({ providerID: "opencode-go", modelID: "one" }, new AbortController().signal)
    assert.equal(result.status, "ready")
    assert.deepEqual(result.items.map(item => [item.label, item.used]),
      [["5 小时", 10], ["每周", 20], ["每月", 30]])
    assert.equal(fetch.mock.callCount(), 1)
    for (const providerID of ["deepseek", "zhipuai-coding-plan", "zai-coding-plan"]) {
      const rejected = await service.query({ providerID, modelID: "one" }, new AbortController().signal)
      assert.equal(rejected.status, "error")
    }
    assert.equal(fetch.mock.callCount(), 1)
  } finally { service.close() }
})

test("contradictory Kimi pools return an explicit error instead of a fresh full-quota result", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    usages: { limit_7d: { used_ratio: 0 } }, usage: { limit: "100", used: "100" },
  }))
  const service = new QuotaService({ timeoutMs: 1000, providers: new Map() }, { resolve: async () => credential })
  try {
    const result = await service.query({ providerID: "kimi-for-coding", modelID: "one" }, new AbortController().signal)
    assert.equal(result.status, "error")
    assert.match(result.message!, /新旧数据不一致/)
    assert.deepEqual(result.items, [])
    assert.equal(result.updatedAt, undefined)
  } finally { service.close() }
})

test("custom scripts still override built-in adapters and redact OAuth secrets", async t => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("Built-in adapter must not run when a script is configured"))
  const oauth = { type: "oauth" as const, access: "fixture-oauth-access", refresh: "fixture-oauth-refresh", expires: Date.now() + 60000 }
  await scriptFixture(`export default ({ credential }) => ({ title: 'override', items: [{ label: credential.access, value: credential.refresh }] })`, async path => {
    const service = new QuotaService({ timeoutMs: 5000, providers: new Map([["kimi-for-coding", path]]) }, { resolve: async () => oauth })
    try {
      const result = await service.query({ providerID: "kimi-for-coding", modelID: "one" }, new AbortController().signal)
      assert.equal(result.status, "ready")
      assert.equal(result.title, "override")
      assert.deepEqual(result.items, [{ label: "[已隐藏]", value: "[已隐藏]" }])
    } finally { service.close() }
  })
})

test("scripts get the current model and only that provider's connection; returned secrets are redacted", async () => {
  await scriptFixture(`export default ({ providerID, modelID, credential }) => ({ title: providerID, items: [
    { label: modelID, value: credential.key }, { label: 'balance', used: 5, limit: 100 }
  ] })`, async path => {
    const calls: string[] = []
    const service = new QuotaService({ timeoutMs: 5000, providers: new Map([["fixture", path]]) }, {
      resolve: async id => { calls.push(id); return credential },
    })
    const result = await service.query(selection, new AbortController().signal)
    assert.equal(result.status, "ready")
    assert.deepEqual(calls, ["fixture"])
    assert.equal(result.items[0].label, "one")
    assert.equal(result.items[0].value, "[已隐藏]")
    assert.ok(!JSON.stringify(result).includes(credential.key))
    service.close()
  })
})

test("a throwing script cannot expose its error or secret in the result", async () => {
  await scriptFixture(`export default ({ credential }) => { console.log(credential.key); throw new Error(credential.key) }`, async path => {
    const service = new QuotaService({ timeoutMs: 5000, providers: new Map([["fixture", path]]) }, { resolve: async () => credential })
    const result = await service.query(selection, new AbortController().signal)
    assert.equal(result.status, "error")
    assert.match(result.message!, /脚本执行失败/)
    assert.ok(!JSON.stringify(result).includes(credential.key))
    service.close()
  })
})

test("redacting short keys preserves field names and RPC structure", async () => {
  await scriptFixture(`export default () => ({ items: [{ label: 'items', value: 'items' }] })`, async path => {
    const service = new QuotaService({ timeoutMs: 5000, providers: new Map([["fixture", path]]) }, {
      resolve: async () => ({ type: "key", key: "items" }),
    })
    const result = await service.query(selection, new AbortController().signal)
    assert.equal(result.status, "ready")
    assert.deepEqual(result.items, [{ label: "[已隐藏]", value: "[已隐藏]" }])
    service.close()
  })
})

test("credential resolution is also bounded by the query timeout", async () => {
  const service = new QuotaService({ timeoutMs: 100, providers: new Map([["fixture", "unused.mjs"]]) }, {
    resolve: async () => new Promise(() => {}),
  })
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const result = await service.query(selection, new AbortController().signal)
    assert.equal(result.message, "额度查询超时")
  } finally { clearTimeout(keepAlive); service.close() }
})

test("a hung synchronous script is terminated without hanging the host", async () => {
  await scriptFixture("export default () => { for (;;) {} }", async path => {
    const service = new QuotaService({ timeoutMs: 200, providers: new Map([["fixture", path]]) }, { resolve: async () => credential })
    const result = await service.query(selection, new AbortController().signal)
    assert.equal(result.status, "error")
    assert.equal(result.message, "额度查询超时")
    service.close()
  })
})

test("cancelling a query terminates its script and plugin shutdown cancels active work", async () => {
  await scriptFixture("export default () => new Promise(() => {})", async path => {
    const service = new QuotaService({ timeoutMs: 5000, providers: new Map([["fixture", path]]) }, { resolve: async () => credential })
    const signal = new AbortController()
    const query = service.query(selection, signal.signal)
    setTimeout(() => signal.abort(), 100)
    await assert.rejects(query)
    const next = service.query(selection, new AbortController().signal)
    setTimeout(() => service.close(), 100)
    await assert.rejects(next)
  })
})

test("model switches clear previous data immediately and ignore late responses", async () => {
  const requests: Array<{ id: string; signal: AbortSignal; done: (value: QuotaResult) => void }> = []
  const panel = new QuotaPanel((input, signal) => new Promise(resolve => requests.push({ id: input.providerID, signal, done: resolve })), () => {}, 0)
  try {
    panel.select(selection)
    panel.select({ providerID: "other", modelID: "two" })
    assert.equal(panel.state.selection?.providerID, "other")
    assert.equal(panel.state.result, undefined)
    assert.equal(requests[0].signal.aborted, true)
    requests[1].done(ready("other", "two"))
    await tick()
    requests[0].done(ready())
    await tick()
    assert.equal(panel.state.result?.providerID, "other")
    panel.select({ providerID: "other", modelID: "three" })
    assert.equal(requests.length, 3)
    assert.equal(panel.state.result, undefined)
  } finally { panel.dispose() }
})

test("failed refreshes retain the last success, while account changes discard it", async () => {
  let fails = false
  const panel = new QuotaPanel(async () => fails ? { ...selection, status: "error", items: [], message: "offline" } : ready(), () => {}, 0)
  try {
    panel.select(selection)
    await tick()
    fails = true
    await panel.refresh()
    assert.equal(panel.state.result?.updatedAt, 1)
    assert.equal(panel.state.error, "offline")
    panel.invalidate()
    assert.equal(panel.state.result, undefined)
    await tick()
    assert.equal(panel.state.result, undefined)
  } finally { panel.dispose() }
})

test("client timeout releases a hung RPC, preserves data and allows manual retry despite ignored abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let hang = false
  let calls = 0
  let late: ((result: QuotaResult) => void) | undefined
  const signals: AbortSignal[] = []
  const panel = new QuotaPanel(async (_selection, signal) => {
    calls++
    signals.push(signal)
    if (hang) return new Promise(resolve => { late = resolve })
    return { ...ready(), updatedAt: calls }
  }, () => {}, 0)
  try {
    panel.select(selection)
    await tick()
    const previous = panel.state.result
    hang = true
    const request = panel.refresh()
    assert.equal(panel.state.loading, true)
    t.mock.timers.tick(15000)
    await tick()
    assert.equal(panel.state.loading, false)
    await request
    assert.match(panel.state.error!, /超时/)
    assert.equal(panel.state.result, previous)
    assert.equal(signals[1].aborted, true)
    hang = false
    await panel.refresh()
    assert.equal(calls, 3)
    assert.equal(panel.state.result?.updatedAt, 3)
    assert.equal(panel.state.error, undefined)
    late!({ ...ready(), updatedAt: 999 })
    await tick()
    assert.equal(panel.state.result?.updatedAt, 3, "A timed-out response must not overwrite the retry")
    t.mock.timers.tick(15000)
    await tick()
    assert.equal(signals[2].aborted, false, "Successful queries must clear their timeout")
  } finally { panel.dispose() }
})

test("periodic refresh recovers after an RPC ignores cancellation and times out", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  let calls = 0
  const panel = new QuotaPanel(async () => ++calls === 1 ? new Promise(() => {}) : ready(), () => {}, 20000)
  try {
    panel.select(selection)
    t.mock.timers.tick(15000)
    await tick()
    assert.equal(panel.state.loading, false)
    assert.match(panel.state.error!, /超时/)
    t.mock.timers.tick(5000)
    await tick()
    assert.equal(calls, 2)
    assert.equal(panel.state.result?.status, "ready")
    assert.equal(panel.state.error, undefined)
  } finally { panel.dispose() }
})

test("same selection does not duplicate requests; project changes and cleanup cancel them", async () => {
  const signals: AbortSignal[] = []
  const panel = new QuotaPanel(async (_input, signal) => { signals.push(signal); return new Promise(() => {}) }, () => {}, 0)
  panel.select(selection, "one")
  panel.select(selection, "one")
  await panel.refresh()
  assert.equal(signals.length, 1)
  panel.select(selection, "two")
  assert.equal(signals[0].aborted, true)
  panel.dispose()
  assert.equal(signals[1].aborted, true)
})

test("script options resolve local paths and reject entries without scripts or non-JS entries", () => {
  const root = resolve(tmpdir())
  assert.equal(options({ providers: { fixture: { script: "quota.mjs" } } }, root).providers.get("fixture"), join(root, "quota.mjs"))
  assert.throws(() => options({ providers: { fixture: { key: "must-not-be-used" } } }, root), /script/)
  assert.throws(() => options({ providers: { fixture: { script: "quota.txt" } } }, root), /mjs/)
})
