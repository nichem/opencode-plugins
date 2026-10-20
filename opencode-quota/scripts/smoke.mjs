import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { setTimeout as delay } from "node:timers/promises"

const executable = process.argv[2]
if (!executable) throw new Error("Pass the OpenCode 2.1.x executable path")
const root = await mkdtemp(join(tmpdir(), "opencode-quota-v2-"))
const project = join(root, "project"), config = join(root, "config", "opencode")
for (const directory of [project, config, join(root, "home")]) await mkdir(directory, { recursive: true })
const plugin = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/")
const script = join(root, "quota.mjs")
const source = `export default ({ modelID, credential }) => ({ title: 'Smoke Quota', items: [
  { label: modelID, used: modelID === 'one' ? 18 : 64, limit: 100, unit: '%' },
  { label: 'connection', value: credential?.key ? 'connected' : 'missing' },
  { label: 'redaction', value: credential?.key ?? 'none' }
] })`
await writeFile(script, source)
const configValue = { plugins: [{ package: plugin, options: { timeoutMs: 1000,
  providers: { "quota-fixture": { script } } } }, `${plugin}/tests/mock-provider`] }
await writeFile(join(config, "opencode.json"), JSON.stringify(configValue))
await writeFile(join(project, "opencode.json"), JSON.stringify(configValue))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^OPENCODE|^QODER/i.test(key)))
Object.assign(env, { XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_CONFIG_DIR: config,
  OPENCODE_TEST_HOME: join(root, "home"), OPENCODE_DB: join(root, "smoke.db") })
const probe = createServer()
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
})
let logs = ""
child.stdout.on("data", chunk => { logs += chunk })
child.stderr.on("data", chunk => { logs += chunk })
child.on("error", error => { logs += String(error) })
async function api(path, body) {
  const url = new URL(path, `http://127.0.0.1:${port}`)
  url.searchParams.set("location[directory]", project)
  const password = /server password (\S+)/.exec(logs)?.[1]
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(password ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const text = await response.text()
  assert.ok(response.ok, `${path}: HTTP ${response.status}`)
  if (!text) return
  const result = JSON.parse(text)
  return result.output ?? result.data ?? result
}
try {
  let plugins = []
  for (let i = 0; i < 100; i++) {
    try {
      plugins = await api("/api/plugin")
      if (["opencode-quota", "quota-test-provider"].every(id => plugins.some(plugin => plugin.id === id && plugin.state.status === "active"))) break
    } catch {}
    if (child.exitCode !== null) throw new Error("Isolated OpenCode exited")
    await delay(200)
  }
  for (const id of ["opencode-quota", "quota-test-provider"])
    assert.equal(plugins.find(plugin => plugin.id === id)?.state.status, "active", `${id} did not activate`)
  const query = modelID => api("/api/rpc/opencode-quota/query", { input: { providerID: "quota-fixture", modelID } })
  await api("/api/integration/quota-fixture/connect/key", { key: "quota-smoke-fake-key-one" })
  const one = await query("one")
  assert.equal(one.status, "ready", JSON.stringify(one))
  assert.equal(one.items[0].used, 18)
  assert.equal(one.items[1].value, "connected")
  assert.equal(one.items[2].value, "[已隐藏]")
  await api("/api/integration/quota-fixture/connect/key", { key: "quota-smoke-fake-key-two" })
  const two = await query("two")
  assert.equal(two.items[0].used, 64)
  assert.equal(two.items[2].value, "[已隐藏]")
  assert.equal((await api("/api/rpc/opencode-quota/query", { input: { providerID: "unsupported-fixture", modelID: "one" } })).status, "unconfigured")
  await writeFile(script, "export default () => { for (;;) {} }")
  const timeout = await query("two")
  assert.equal(timeout.status, "error")
  assert.equal(timeout.message, "额度查询超时")
  await writeFile(script, source)
  assert.equal((await query("one")).status, "ready")
  console.log("PASS: native OpenCode loaded the plugin, resolved saved fixture credentials, queried scripts for two models, redacted secrets, and recovered after worker timeout")
} catch (error) {
  await writeFile(join(root, "server.log"), logs.replace(/server password \S+/g, "server password [REDACTED]"))
  throw error
} finally {
  child.kill("SIGKILL")
  console.log(`Isolated smoke data: ${root}`)
}
