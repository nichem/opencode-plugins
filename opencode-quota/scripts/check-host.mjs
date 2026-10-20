import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { Host } from "@opencode/plugin/host"
import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"

const directory = fileURLToPath(new URL("..", import.meta.url))
const entries = Host.resolve({ directory, name: "opencode-quota" })
assert.ok(entries.server?.endsWith("index.ts"))
assert.ok(entries.tui?.endsWith("tui.tsx"))
const server = await Host.load(entries.server)
assert.equal(server.default.id, "opencode-quota")
const source = await readFile(new URL(entries.tui), "utf8")
const compiled = await transformAsync(source, {
  filename: fileURLToPath(entries.tui), configFile: false, babelrc: false,
  presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }], typescript],
})
assert.ok(compiled.code.includes("opencode-quota.tui"))
assert.ok(!compiled.code.includes("<QuotaCard"))
console.log("PASS: OpenCode 2.1.0 host resolves both entries, loads the server, and the TUI JSX compiles")
