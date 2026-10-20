import test, { type TestContext } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import plugin from "../index.ts"
import { allowsBuiltin } from "../src/builtins.ts"
import type { QuotaResult, Selection } from "../src/data.ts"

const providerID = "deepseek"
const nativePackage = "@opencode/ai/providers/deepseek"
const official = "https://api.deepseek.com/v1"
const proxy = "https://gateway.example.invalid/v1"
const selected = { providerID, modelID: "one" }
type Source = { package?: string; settings?: Record<string, unknown> }
type Model = Source & { id: string; providerID: string; variants?: Source[] }

async function fixture(t: TestContext, input: { provider?: Source; models?: Model[]; options?: Record<string, unknown> } = {}) {
  const provider = { id: providerID, integrationID: providerID, package: nativePackage,
    settings: { baseURL: official }, ...input.provider }
  const models = input.models ?? [{ id: "one", providerID }]
  let handler: (input: Selection, context: { signal: AbortSignal }) => Promise<QuotaResult>
  const fetch = t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://api.deepseek.com/user/balance")
    return Response.json({ balance_infos: [{ currency: "CNY", total_balance: "2.00" }] })
  })
  const list = t.mock.fn(async () => ({ data: models }))
  const active = t.mock.fn(async () => ({ type: "credential" }))
  const credential = t.mock.fn(async () => ({ type: "key", key: "fixture-gateway-key-only" }))
  const cleanup = await plugin.setup({ options: input.options ?? {}, location: { directory: tmpdir() },
    provider: { get: async () => ({ data: provider }) }, model: { list },
    integration: { connection: { active, resolve: credential } },
    rpc: { register: async (_schema: unknown, handlers: { query: typeof handler }) => {
      handler = handlers.query
      return { dispose: async () => {} }
    } },
  } as unknown as Parameters<typeof plugin.setup>[0])
  return { provider, models, fetch, list, active, credential,
    query: (selection = selected) => handler(selection, { signal: new AbortController().signal }),
    close: async () => { if (typeof cleanup === "function") await cleanup() },
  }
}

test("official provider endpoints remain available, including verified native defaults", async t => {
  const f = await fixture(t)
  try {
    assert.equal((await f.query()).status, "ready")
    assert.equal(f.credential.mock.callCount(), 1)
    f.provider.settings = {}
    assert.equal((await f.query()).status, "ready")
    assert.equal(f.fetch.mock.callCount(), 2)
  } finally { await f.close() }
})

test("a provider proxy is blocked before reading its connection or sending the key", async t => {
  const f = await fixture(t, { provider: { settings: { baseURL: proxy } } })
  try {
    const result = await f.query()
    assert.equal(result.status, "unconfigured")
    assert.match(result.message!, /额度脚本/)
    assert.equal(f.active.mock.callCount(), 0)
    assert.equal(f.credential.mock.callCount(), 0)
    assert.equal(f.fetch.mock.callCount(), 0)
    assert.ok(!JSON.stringify(result).includes(proxy))
  } finally { await f.close() }
})

test("a model endpoint override is checked even when the provider still points at the official API", async t => {
  const f = await fixture(t, { models: [{ ...selected, id: "one", settings: { baseURL: proxy } }] })
  try {
    assert.equal((await f.query()).status, "unconfigured")
    assert.equal(f.credential.mock.callCount(), 0)
    assert.equal(f.fetch.mock.callCount(), 0)
  } finally { await f.close() }
})

test("unsafe variants and unavailable model metadata cannot bypass endpoint validation", async t => {
  const f = await fixture(t, { models: [{ id: "one", providerID, variants: [{ settings: { baseURL: proxy } }] }] })
  try {
    assert.equal((await f.query()).status, "unconfigured")
    f.models.length = 0
    assert.equal((await f.query()).status, "unconfigured")
    assert.equal(f.active.mock.callCount(), 0)
    assert.equal(f.fetch.mock.callCount(), 0)
  } finally { await f.close() }
})

test("endpoint validation is refreshed on every request and follows a model's effective override", async t => {
  const f = await fixture(t)
  try {
    assert.equal((await f.query()).status, "ready")
    f.provider.settings = { baseURL: proxy }
    assert.equal((await f.query()).status, "unconfigured")
    assert.equal(f.credential.mock.callCount(), 1)
    f.models[0].settings = { baseURL: official }
    assert.equal((await f.query()).status, "ready")
    assert.equal(f.fetch.mock.callCount(), 2)
  } finally { await f.close() }
})

test("origin checks reject lookalike hosts, other regions, URL credentials, ports and unverifiable runtimes", () => {
  for (const baseURL of [proxy, "https://api.deepseek.com.example.invalid/v1", "http://api.deepseek.com/v1",
    "https://user:password@api.deepseek.com/v1", "https://api.deepseek.com:8443/v1", "not-a-url", "", null, false])
    assert.equal(allowsBuiltin(providerID, { settings: { baseURL } }, {}), false)
  assert.equal(allowsBuiltin(providerID, { settings: { baseURL: "https://API.DEEPSEEK.COM:443/v1/" } }, {}), true)
  assert.equal(allowsBuiltin(providerID, { package: nativePackage }, {}), true)
  assert.equal(allowsBuiltin(providerID, { package: nativePackage }, { package: "@fixture/private-runtime" }), false)
  assert.equal(allowsBuiltin(providerID, {}, {}), false)
  assert.equal(allowsBuiltin("unknown", { settings: { baseURL: official } }, {}), false)
  assert.equal(allowsBuiltin("zhipuai-coding-plan", { settings: { baseURL: "https://api.z.ai/api/coding/paas/v4" } }, {}), false)
  assert.equal(allowsBuiltin("kimi-code-plan-cn", { settings: { baseURL: "https://api.kimi.ai/coding/v1" } }, {}), false)
  assert.equal(allowsBuiltin(providerID, { settings: { baseURL: official } }, { variants: [{ settings: { baseURL: official } }, {}] }), true)
})

test("every built-in recognizes its own official catalog endpoint and rejects a gateway override", () => {
  for (const [id, baseURL] of [
    ["opencode-go", "https://opencode.ai/zen/go/v1"],
    ["deepseek", "https://api.deepseek.com/v1"],
    ["zhipuai-coding-plan", "https://open.bigmodel.cn/api/coding/paas/v4"],
    ["zai-coding-plan", "https://api.z.ai/api/coding/paas/v4"],
    ["kimi-for-coding", "https://api.kimi.com/coding/v1"],
    ["kimi-code-plan-cn", "https://api.kimi.com/coding/v1"],
    ["kimi-code-plan-global", "https://api.kimi.ai/coding/v1"],
  ]) {
    assert.equal(allowsBuiltin(id, { settings: { baseURL } }, {}), true, id)
    assert.equal(allowsBuiltin(id, { settings: { baseURL } }, { settings: { baseURL: proxy } }), false, id)
  }
})

test("custom quota scripts still run against their own connection when the model endpoint is a proxy", async t => {
  const root = await mkdtemp(join(tmpdir(), "quota-endpoint-test-"))
  let f: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    const script = join(root, "quota.mjs")
    await writeFile(script, "export default ({credential}) => ({items:[{label:'connected',value:credential.key}]})")
    f = await fixture(t, { provider: { settings: { baseURL: proxy } },
      options: { providers: { deepseek: { script } } } })
    const result = await f.query()
    assert.equal(result.status, "ready")
    assert.deepEqual(result.items, [{ label: "connected", value: "[已隐藏]" }])
    assert.equal(f.list.mock.callCount(), 0)
    assert.equal(f.credential.mock.callCount(), 1)
    assert.equal(f.fetch.mock.callCount(), 0)
  } finally {
    await f?.close()
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    await rm(root, { recursive: true, force: true })
  }
})
