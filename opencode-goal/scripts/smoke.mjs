import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { setTimeout as delay } from "node:timers/promises"

const executable = process.argv[2]
if (!executable) throw new Error("Pass the OpenCode 2.x executable path")
const root = mkdtempSync(join(tmpdir(), "opencode-goal-v2-"))
const project = join(root, "project"), config = join(root, "config", "opencode")
for (const dir of [project, config, join(root, "home")]) mkdirSync(dir, { recursive: true })
const plugin = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/")
writeFileSync(join(config, "opencode.json"), JSON.stringify({ plugins: [plugin, `${plugin}/tests/mock-provider`] }))
writeFileSync(join(project, "opencode.json"), JSON.stringify({ plugins: [plugin, `${plugin}/tests/mock-provider`] }))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^OPENCODE|^QODER/i.test(key)))
Object.assign(env, { XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_CONFIG_DIR: config,
  OPENCODE_TEST_HOME: join(root, "home"), OPENCODE_DB: join(root, "smoke.db") })
const probe = createServer()
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
let logs = ""
child.stdout.on("data", chunk => { logs += chunk })
child.stderr.on("data", chunk => { logs += chunk })
child.on("error", error => { logs += String(error) })
const base = `http://127.0.0.1:${port}`
async function api(path, body) {
  const url = new URL(path, base)
  url.searchParams.set("location[directory]", project)
  const password = /server password (\S+)/.exec(logs)?.[1]
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json",
    ...(password ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const text = await response.text()
  assert.ok(response.ok, `${response.status}: ${text}`)
  if (!text) return
  const data = JSON.parse(text)
  return data.data ?? data
}
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { await api("/api/command"); ready = true; break } catch { await delay(200) }
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`)
  }
  assert.ok(ready, logs.replace(/server password \S+/g, "server password [REDACTED]"))
  let plugins = []
  for (let i = 0; i < 60; i++) {
    plugins = await api("/api/plugin")
    if (plugins.some(plugin => plugin.id === "opencode-goal") && plugins.some(plugin => plugin.id === "goal-test-provider")) break
    await delay(200)
  }
  const commands = await api("/api/command")
  if (!plugins.some(plugin => plugin.id === "opencode-goal")) console.error("Diagnostic", JSON.stringify(await api("/api/config")), JSON.stringify(await api("/api/location")))
  assert.equal(plugins.find(plugin => plugin.id === "opencode-goal")?.state.status, "active", JSON.stringify(plugins.filter(p => p.source.type !== "builtin")))
  assert.equal(plugins.find(plugin => plugin.id === "goal-test-provider")?.state.status, "active", JSON.stringify(plugins.filter(p => p.source.type !== "builtin")))
  assert.ok(commands.some(command => command.name === "goal"))
  const session = await api("/api/session", { title: "Goal migration smoke", model: { providerID: "goal-test", id: "test" } })
  await api(`/api/session/${session.id}/command`, { name: "goal", text: "Finish the deterministic offline smoke task" })
  let messages = []
  for (let i = 0; i < 100; i++) {
    await delay(200)
    messages = await api(`/api/session/${session.id}/context`)
    if (JSON.stringify(messages).includes("Goal complete.")) break
  }
  assert.match(JSON.stringify(messages), /Goal complete\./, JSON.stringify(messages))
  await api(`/api/session/${session.id}/command`, { name: "goal", text: "" })
  const status = await api("/api/rpc/opencode-goal/status", { input: { sessionID: session.id } })
  assert.match(JSON.stringify(status), /Status: complete/)
  messages = await api(`/api/session/${session.id}/context`)
  const continuations = messages.filter(message => message.metadata?.goal === "continuation").length
  assert.equal(continuations, 2, JSON.stringify(messages))
  const assistantCount = messages.filter(message => message.type === "assistant").length
  await delay(400)
  const afterStatus = await api(`/api/session/${session.id}/context`)
  assert.equal(afterStatus.filter(message => message.metadata?.goal === "continuation").length, continuations)
  assert.equal(afterStatus.filter(message => message.type === "assistant").length, assistantCount, "Viewing /goal must not call the model")
  console.log("PASS: actual OpenCode 2.x loaded /goal, auto-continued, executed update_goal, and stopped after completion.")
} catch (error) {
  writeFileSync(join(root, "server.log"), logs.replace(/server password \S+/g, "server password [REDACTED]"))
  throw error
} finally {
  child.kill("SIGKILL")
  console.log(`Isolated smoke data: ${root}`)
}
