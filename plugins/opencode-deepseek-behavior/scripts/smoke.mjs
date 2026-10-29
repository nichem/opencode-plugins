import assert from "node:assert/strict"
import { cp, mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:net"
import { setTimeout as delay } from "node:timers/promises"

const executable = process.argv[2]
if (!executable) throw new Error("Pass the OpenCode 2.x executable path")
const directory = fileURLToPath(new URL("..", import.meta.url))
const fixtureBase = join(directory, "node_modules")
const root = await mkdtemp(join(fixtureBase, ".behavior-smoke-"))
const config = join(root, "config", "opencode"), project = join(root, "project"), other = join(root, "other")
for (const path of [config, project, other, join(root, "home")]) await mkdir(path, { recursive: true })
const plugin = directory.replaceAll("\\", "/")
const legacyDirectory = join(root, "legacy", "opencode-deepseek-behavior")
await mkdir(legacyDirectory, { recursive: true })
for (const file of ["package.json", "index.ts", "tui.js", "src"])
  await cp(join(directory, file), join(legacyDirectory, file), { recursive: true })
await symlink(join(directory, "node_modules"), join(legacyDirectory, "node_modules"), process.platform === "win32" ? "junction" : "dir")
const configuration = { plugins: [legacyDirectory.replaceAll("\\", "/"), `${plugin}/tests/mock-provider`] }
await writeFile(join(config, "opencode.json"), JSON.stringify(configuration))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^OPENCODE|^GIT_/i.test(key)))
Object.assign(env, {
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
  OPENCODE_CONFIG_DIR: config, OPENCODE_TEST_HOME: join(root, "home"), OPENCODE_DB: join(root, "smoke.db"),
  GIT_CONFIG_GLOBAL: join(root, "empty.gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
})
await writeFile(env.GIT_CONFIG_GLOBAL, "")
for (const path of [project, other]) {
  await writeFile(join(path, "opencode.json"), JSON.stringify(configuration))
  // An isolated repository stops config discovery before the real workspace.
  execFileSync("git", ["init", "--quiet"], { cwd: path, env, windowsHide: true, stdio: "pipe" })
}
const probe = createServer()
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
let child, logs = ""
async function api(path, body, location = project) {
  const url = new URL(path, `http://127.0.0.1:${port}`)
  url.searchParams.set("location[directory]", location)
  const password = /server password (\S+)/.exec(logs)?.[1]
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(password
      ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  })
  assert.ok(response.ok, `${path}: HTTP ${response.status}`)
  const result = await response.json()
  return result.output ?? result.data ?? result
}
const state = (location = project) => api("/api/rpc/opencode-deepseek-behavior/get", { input: {} }, location)
const set = enabled => api("/api/rpc/opencode-deepseek-behavior/set", { input: { enabled } })
async function start() {
  logs = ""
  child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.on("data", chunk => { logs += chunk })
  child.stderr.on("data", chunk => { logs += chunk })
  child.on("error", error => { logs += error.name })
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const plugins = await api("/api/plugin")
      if (["opencode-deepseek-behavior", "deepseek-behavior-fixture"].every(id =>
        plugins.some(plugin => plugin.id === id && plugin.state.status === "active"))) return
    } catch {}
    if (child.exitCode !== null) throw new Error("Isolated OpenCode exited")
    await delay(150)
  }
  throw new Error("Isolated plugins did not become active")
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const exited = new Promise(resolve => child.once("exit", resolve))
  child.kill("SIGKILL")
  await exited
}
async function request(modelID, expectedCopies) {
  const records = () => api("/api/rpc/deepseek-behavior-fixture/requests", { input: {} })
  const before = (await records()).length
  const session = await api("/api/session", { title: "Artificial behavior fixture",
    model: { providerID: "behavior-fixture", id: modelID } })
  await api(`/api/session/${session.id}/prompt`, { text: "Reply with the artificial fixture response." })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const after = await records()
    const added = after.slice(before).filter(item => item.modelID === modelID)
    if (added.length) {
      assert.equal(added[0].copies, expectedCopies)
      return
    }
    await delay(100)
  }
  throw new Error("Offline fixture model was not called")
}
try {
  await start()
  assert.deepEqual(await state(), { enabled: true })
  await request("DeepSeek-fixture", 1)
  await request("ordinary-fixture", 0)
  assert.deepEqual(await set(false), { enabled: false })
  await request("DeepSeek-fixture", 0)
  assert.deepEqual(await state(other), { enabled: false })
  await stop()
  // Simulate an upgrade that changes the package's source directory but keeps its ID.
  configuration.plugins[0] = plugin
  for (const path of [config, project, other])
    await writeFile(join(path, "opencode.json"), JSON.stringify(configuration))
  await start()
  assert.deepEqual(await state(), { enabled: false })
  await request("DeepSeek-fixture", 0)
  await set(true)
  await request("DeepSeek-fixture", 1)
  console.log("PASS: native OpenCode loads both plugins; only DeepSeek requests receive the prompt; saved state spans projects, sessions, a source-directory migration and a server restart")
} finally {
  await stop()
  assert.ok(resolve(root).startsWith(resolve(fixtureBase) + sep))
  await rm(root, { recursive: true, force: true })
}
