import test from "node:test"
import assert from "node:assert/strict"
import { credentialCandidates, resolveConnection } from "../src/connection.ts"

const key = { type: "key" as const, key: "fixture-key" }
const oauth = { type: "oauth" as const, access: "fixture-access", refresh: "fixture-refresh", expires: 0 }

test("credential candidates prefer a built-in provider's own integration", () => {
  assert.deepEqual(credentialCandidates("opencode-go", "opencode"), ["opencode-go", "opencode"])
  assert.deepEqual(credentialCandidates("deepseek", "deepseek"), ["deepseek"])
  assert.deepEqual(credentialCandidates("custom", "custom-integration"), ["custom-integration"])
  assert.deepEqual(credentialCandidates("opencode-go", undefined), [])
})

test("Go uses its saved Key before the shared Console connection", async () => {
  const calls: string[] = []
  const result = await resolveConnection("opencode-go", "opencode", {
    active: async id => { calls.push(id); return { type: "credential" } },
    resolve: async () => key,
  })
  assert.equal(result, key)
  assert.deepEqual(calls, ["opencode-go"])
})

test("Go falls back to the provider's Console connection when no Go Key is active", async () => {
  const calls: string[] = []
  const console = { type: "credential" as const, id: "console" }
  const result = await resolveConnection("opencode-go", "opencode", {
    active: async id => { calls.push(id); return id === "opencode-go" ? undefined : console },
    resolve: async connection => {
      assert.equal(connection, console)
      return oauth
    },
  })
  assert.equal(result, oauth)
  assert.deepEqual(calls, ["opencode-go", "opencode"])
})

test("custom providers continue to use only their configured integration", async () => {
  const calls: string[] = []
  const result = await resolveConnection("custom", "custom-integration", {
    active: async id => { calls.push(id); return { type: "credential" } },
    resolve: async () => key,
  })
  assert.equal(result, key)
  assert.deepEqual(calls, ["custom-integration"])
})

test("non-credential connections and missing mappings do not resolve a credential", async () => {
  for (const [providerID, integrationID] of [["opencode-go", "opencode"], ["deepseek", undefined]] as const) {
    const result = await resolveConnection(providerID, integrationID, {
      active: async () => ({ type: "env" }),
      resolve: async () => assert.fail("unexpected credential resolve"),
    })
    assert.equal(result, undefined)
  }
})
