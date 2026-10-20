import test from "node:test"
import assert from "node:assert/strict"
import { formatValue, remaining } from "../src/data.ts"
import { DEEPSEEK_BALANCE_URL, parseDeepSeek, queryDeepSeek } from "../src/deepseek.ts"
import { KIMI_GLOBAL_USAGE_URL, KIMI_USAGE_URL, parseKimi, queryKimi } from "../src/kimi.ts"
import { ZAI_USAGE_URL, ZHIPU_USAGE_URL, parseZhipu, queryZhipu } from "../src/zhipu.ts"

const key = "fixture-secret-only"
const resetsAt = "2026-11-01T00:00:00.000Z"
const balance = { is_available: true, balance_infos: [{
  currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00",
}] }
const zhipu = { code: 200, success: true, data: { limits: [
  { type: "TOKENS_LIMIT", percentage: 23 },
  { type: "TIME_LIMIT", currentValue: 8, usage: 100, percentage: 8 },
] } }
const kimi = { usages: { limit_5h: { used_ratio: 0.3, reset_time: resetsAt }, limit_7d: { used_ratio: 0.2 } } }

test("DeepSeek preserves currency and balance precision, including grants and topped-up funds", () => {
  const data = parseDeepSeek(balance)
  assert.equal(data.title, "DeepSeek")
  assert.deepEqual(data.items, [
    { label: "可用余额（CNY）", value: "¥110.00" },
    { label: "赠送余额（CNY）", value: "¥10.00" },
    { label: "充值余额（CNY）", value: "¥100.00" },
  ])
  const multiple = parseDeepSeek({ balance_infos: [...balance.balance_infos, { currency: "USD", total_balance: "0.0001" }] })
  assert.equal(multiple.items[3].value, "$0.0001")
  assert.equal(remaining(multiple.items[3]), undefined)
  assert.equal(parseDeepSeek({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00" }] }).items[0].value, "¥0.00")
})

test("DeepSeek rejects missing, nonnumeric and malformed balances instead of inventing zero", () => {
  for (const value of [null, { balance_infos: [] }, { balance_infos: [{ currency: "CNY" }] },
    ...[undefined, null, true, "", " ", "NaN", "Infinity", NaN].map(total_balance => ({ balance_infos: [{ currency: "CNY", total_balance }] })),
    { balance_infos: [{ currency: "EUR", total_balance: "1" }] }]) assert.throws(() => parseDeepSeek(value))
})

test("Zhipu supports original token percentages and monthly MCP counts without a reset timestamp", () => {
  const data = parseZhipu(zhipu)
  assert.equal(data.title, "智谱 Coding Plan")
  assert.deepEqual(data.items, [
    { label: "5 小时", used: 23, limit: 100, unit: "%" },
    { label: "MCP（每月）", used: 8, limit: 100, unit: "次" },
  ])
})

test("Zhipu maps credit windows by their declared unit, keeps server percentages and parses epoch resets", () => {
  const data = parseZhipu({ code: "200", data: { limits: [
    { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: "20", usage: 10000, currentValue: 2005, nextResetTime: Date.parse(resetsAt) },
    { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 100, usage: 2000, currentValue: 2005, nextResetTime: 0 },
    { type: "TIME_LIMIT", unit: 5, number: 1, currentValue: 10, usage: 100 },
  ] } })
  assert.deepEqual(data.items.map(item => item.label), ["每周", "5 小时", "MCP（每月）"])
  assert.equal(data.items[0].used, 20)
  assert.equal(data.items[0].resetsAt, resetsAt)
  assert.equal(data.items[1].resetsAt, undefined)
  assert.equal(formatValue(data.items[1]), "剩余 0%")
  assert.equal(data.items[2].used, 10)
  assert.equal(parseZhipu({ limits: [{ type: "TOKENS_LIMIT", currentValue: 2, usage: 10 }] }).items[0].used, 20)
})

test("Zhipu rejects API failures and missing quota values without echoing upstream messages", () => {
  for (const value of [{ code: 401, msg: key }, { success: false, message: key, data: zhipu.data },
    { limits: [] }, { limits: [{ type: "UNKNOWN", percentage: 0 }] },
    ...[undefined, null, true, "", -1, NaN].map(percentage => ({ limits: [{ type: "TOKENS_LIMIT", percentage }] })),
    { limits: [{ type: "TOKENS_LIMIT", usage: -1, currentValue: -2 }] },
    { limits: [{ type: "TOKENS_LIMIT", percentage: 0, nextResetTime: "invalid" }] }]) {
    assert.throws(() => parseZhipu(value), error => !String(error).includes(key))
  }
})

test("Kimi supports original weekly usage and rolling windows, including string counts and remaining", () => {
  const data = parseKimi({ usage: { limit: "2048", used: "214", remaining: "1834", resetTime: resetsAt },
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "200", remaining: "61", resetTime: resetsAt } }] })
  assert.deepEqual(data.items.map(item => [item.label, item.used, item.limit]), [["5 小时", 139, 200], ["每周", 214, 2048]])
  assert.ok(data.items.every(item => item.resetsAt === resetsAt))
  assert.equal(data.items.length, 2, "Missing monthly windows must stay absent")
})

test("Kimi keeps agreeing current pools, preserves zero and includes monthly pools only when provided", () => {
  const data = parseKimi({ usages: { ...kimi.usages,
    limit_month_total: { used_ratio: "0.4", reset_time: resetsAt }, limit_month_code: { used_ratio: 0 },
  }, usage: { limit: "100", used: "20" },
  limits: [{ window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "100", used: "30" } }] })
  assert.deepEqual(data.items.map(item => [item.label, item.used]), [["5 小时", 30], ["每周", 20], ["每月总额度", 40], ["每月 Coding", 0]])
  assert.equal(formatValue(data.items[3]), "剩余 100%")
  assert.equal(parseKimi({ usages: { limit_5h: { used_ratio: 0 } } }).items.length, 1)
})

test("Kimi rejects the reported exhausted weekly pool masked by a zero ratio", () => {
  // Same response shape reported in MoonshotAI/kimi-code#3951. Reset timestamps
  // differ by less than two seconds, rather than representing different cycles.
  assert.throws(() => parseKimi({
    usage: { limit: "100", used: "100", resetTime: "2026-09-24T02:09:07.465054Z" },
    usages: { limit_7d: { used_ratio: 0, reset_time: "2026-09-24T02:09:06Z" } },
  }), /同一额度窗口的新旧数据不一致/)
})

test("Kimi detects contradictory rolling pools and the inverse weekly conflict", () => {
  assert.throws(() => parseKimi({ usages: { limit_5h: { used_ratio: 0 } },
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "20" } }],
  }), /新旧数据不一致/)
  assert.throws(() => parseKimi({ usages: { limit_7d: { used_ratio: 1 } },
    usage: { limit: "100", used: "0" },
  }), /新旧数据不一致/)
})

test("Kimi tolerates rounding differences, obsolete cycles and unusable deprecated fields", () => {
  const rounded = parseKimi({ usages: { limit_7d: { used_ratio: 1 / 3 } }, usage: { limit: "100", used: "33" } })
  assert.equal(formatValue(rounded.items[0]), "剩余 67%")
  const differentCycle = parseKimi({ usages: { limit_7d: { used_ratio: 0.2, reset_time: "2026-11-08T00:00:00Z" } },
    usage: { limit: "100", used: "100", resetTime: "2026-11-01T00:00:00Z" } })
  assert.equal(formatValue(differentCycle.items[0]), "剩余 80%")
  const deprecated = parseKimi({ usages: { limit_7d: { used_ratio: 0.25 } }, usage: { limit: "0", used: "0" } })
  assert.equal(formatValue(deprecated.items[0]), "剩余 75%")
  const overage = parseKimi({ usages: { limit_7d: { used_ratio: 1.1 } }, usage: { limit: "100", used: "150" } })
  assert.equal(formatValue(overage.items[0]), "剩余 0%")
})

test("Kimi rejects missing and malformed usage, never treating unknown consumption as zero", () => {
  for (const value of [null, {}, { usages: {} }, { usage: { limit: 100 } },
    { usage: { limit: 0, used: 0 } }, { usage: { limit: 100, remaining: 101 } },
    ...[undefined, null, true, "", -0.1, NaN].map(used_ratio => ({ usages: { limit_5h: { used_ratio } } })),
    { usages: { limit_5h: { used_ratio: 0.1, reset_time: "invalid" } } }]) assert.throws(() => parseKimi(value))
})

const routes = [
  { name: "DeepSeek", url: DEEPSEEK_BALANCE_URL, authorization: `Bearer ${key}`, payload: balance,
    query: (signal: AbortSignal, transport: typeof fetch) => queryDeepSeek(key, signal, transport) },
  { name: "Zhipu CN", url: ZHIPU_USAGE_URL, authorization: key, payload: zhipu,
    query: (signal: AbortSignal, transport: typeof fetch) => queryZhipu(key, signal, "cn", transport) },
  { name: "Z.ai", url: ZAI_USAGE_URL, authorization: key, payload: zhipu,
    query: (signal: AbortSignal, transport: typeof fetch) => queryZhipu(key, signal, "global", transport) },
  { name: "Kimi CN", url: KIMI_USAGE_URL, authorization: `Bearer ${key}`, payload: kimi,
    query: (signal: AbortSignal, transport: typeof fetch) => queryKimi(key, signal, "cn", transport) },
  { name: "Kimi global", url: KIMI_GLOBAL_USAGE_URL, authorization: `Bearer ${key}`, payload: kimi,
    query: (signal: AbortSignal, transport: typeof fetch) => queryKimi(key, signal, "global", transport) },
]

for (const route of routes) test(`${route.name} sends a cancellable GET only to its official region with redirects disabled`, async () => {
  const signal = new AbortController().signal
  let calls = 0
  const transport: typeof fetch = async (input, init) => {
    calls++
    assert.equal(input, route.url)
    assert.equal(init?.method, "GET")
    assert.equal(init?.signal, signal)
    assert.equal(init?.redirect, "error")
    assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), { accept: "application/json", authorization: route.authorization })
    return Response.json(route.payload)
  }
  assert.ok((await route.query(signal, transport)).items.length > 0)
  assert.equal(calls, 1)
  for (const status of [401, 403, 429, 500]) {
    let attempts = 0
    await assert.rejects(route.query(signal, async () => { attempts++; return new Response(key, { status }) }), error => {
      assert.ok(!String(error).includes(key))
      return true
    })
    assert.equal(attempts, 1, "Do not retry the same credential against another region")
  }
})

test("new provider adapters hide network/JSON errors and honour cancellation", async () => {
  const signal = new AbortController().signal
  for (const route of routes) {
    await assert.rejects(route.query(signal, async () => { throw new Error(key) }), error => /网络异常/.test(String(error)) && !String(error).includes(key))
    await assert.rejects(route.query(signal, async () => new Response(key)), error => /无效的 JSON/.test(String(error)) && !String(error).includes(key))
    await assert.rejects(route.query(AbortSignal.abort(), async () => assert.fail("An aborted request must not fetch")))
  }
})
