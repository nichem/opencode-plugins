import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { deleteLastMessage } from "../src/delete.ts"

const executable = process.argv[2]
if (!executable) throw new Error("Pass the OpenCode 2.x executable path")
const root = mkdtempSync(join(tmpdir(), "opencode-delete-v2-"))
const project = join(root, "project"), config = join(root, "config", "opencode")
for (const dir of [project, config, join(root, "home")]) mkdirSync(dir, { recursive: true })
const plugin = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/")
const configValue = { plugins: [`${plugin}/tests/mock-provider`] }
writeFileSync(join(config, "opencode.json"), JSON.stringify(configValue))
writeFileSync(join(project, "opencode.json"), JSON.stringify(configValue))
writeFileSync(join(config, "cli.json"), JSON.stringify({ plugins: [plugin] }))
writeFileSync(join(project, "fixture.txt"), "original\n")
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^OPENCODE|^QODER|^GIT_/i.test(key)))
Object.assign(env, { XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_CONFIG_DIR: config,
  OPENCODE_TEST_HOME: join(root, "home"), OPENCODE_DB: join(root, "smoke.db"), GIT_CONFIG_GLOBAL: join(root, "empty.gitconfig"), GIT_CONFIG_NOSYSTEM: "1" })
writeFileSync(env.GIT_CONFIG_GLOBAL, "")
for (const args of [["init"], ["add", "fixture.txt"], ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "fixture"]]) {
  execFileSync("git", args, { cwd: project, env, windowsHide: true, stdio: "pipe" })
}
const probe = createServer()
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
let logs = ""
child.stdout.on("data", chunk => { logs += chunk })
child.stderr.on("data", chunk => { logs += chunk })
child.on("error", error => { logs += String(error) })
async function api(path, body, query = {}, raw = false) {
  const url = new URL(path, `http://127.0.0.1:${port}`)
  url.searchParams.set("location[directory]", project)
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value)
  const password = /server password (\S+)/.exec(logs)?.[1]
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json",
    ...(password ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const text = await response.text()
  assert.ok(response.ok, `${response.status}: ${text}`)
  if (!text) return
  const data = JSON.parse(text)
  return raw ? data : data.data ?? data
}
const client = {
  message: { list: ({ sessionID, ...query }) => api(`/api/session/${sessionID}/message`, undefined, query, true) },
  session: {
    active: () => api("/api/session/active"),
    get: ({ sessionID }) => api(`/api/session/${sessionID}`),
    inbox: { list: ({ sessionID }) => api(`/api/session/${sessionID}/inbox`) },
    revert: {
      stage: ({ sessionID, ...body }) => api(`/api/session/${sessionID}/revert/stage`, body),
      commit: ({ sessionID }) => api(`/api/session/${sessionID}/revert/commit`, {}),
    },
  },
}
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    try {
      const plugins = await api("/api/plugin")
      if (plugins.some(p => p.id === "delete-test-provider" && p.state.status === "active")) { ready = true; break }
    } catch {}
    if (child.exitCode !== null) throw new Error("Server exited")
    await delay(200)
  }
  assert.ok(ready, "Mock provider did not load")
  const session = await api("/api/session", { title: "Delete smoke", model: { providerID: "delete-test", id: "test" } })
  const sessionID = session.id
  await api(`/api/session/${sessionID}/prompt`, { text: "Use smoke_write then reply", resume: true })
  async function waitForReply(text) {
    for (let i = 0; i < 100; i++) {
      const messages = await api(`/api/session/${sessionID}/context`)
      if (JSON.stringify(messages).includes(text) && !(await client.session.active())[sessionID]) return messages
      await delay(200)
    }
    throw new Error(`Reply timeout: ${text}`)
  }
  const original = await waitForReply("Final reply 2")
  const assistants = original.filter(m => m.type === "assistant")
  assert.equal(assistants.length, 2, JSON.stringify(original))
  assert.ok(assistants[0].content.some(p => p.type === "tool"), "First assistant must include a tool record")
  assert.equal(readFileSync(join(project, "fixture.txt"), "utf8"), "changed by tool\n")
  console.log("PASS: real server produced a tool message and a separate final reply.")
  assert.equal(await deleteLastMessage(client, sessionID), assistants[1].id)
  let after = await api(`/api/session/${sessionID}/context`)
  assert.deepEqual(after.filter(m => m.type === "assistant").map(m => m.id), [assistants[0].id])
  assert.equal(readFileSync(join(project, "fixture.txt"), "utf8"), "changed by tool\n")
  assert.equal(await deleteLastMessage(client, sessionID), assistants[0].id)
  after = await api(`/api/session/${sessionID}/context`)
  assert.equal(after.filter(m => m.type === "assistant").length, 0)
  assert.ok(after.some(m => m.type === "user"))
  assert.equal(readFileSync(join(project, "fixture.txt"), "utf8"), "changed by tool\n")
  await assert.rejects(deleteLastMessage(client, sessionID), /末尾不是 AI/)
  assert.equal((await client.session.get({ sessionID })).revert, undefined)
  console.log("PASS: repeated deletion removed only assistant messages, preserved the user and tool-written file.")
  await api(`/api/session/${sessionID}/prompt`, { text: "Continue after deletion", resume: true })
  await waitForReply("Final reply 3")
  console.log("PASS: conversation continued after deletion without automatic regeneration.")
} finally {
  child.kill("SIGKILL")
  writeFileSync(join(root, "server.log"), logs.replace(/server password \S+/g, "server password [REDACTED]"))
  console.log(`Isolated smoke data: ${root}`)
}
