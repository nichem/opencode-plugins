import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { Host } from "@opencode/plugin/host"

const directory = fileURLToPath(new URL("..", import.meta.url))
const entries = Host.resolve({ directory })
assert.ok(entries.tui)
assert.equal(entries.server, undefined)
const mod = await Host.load(entries.tui)
assert.equal(mod.default.id, "opencode-message-delete.tui")
assert.equal(typeof mod.default.setup, "function")
console.log("PASS: native 2.0.27 host resolves and loads the TUI-only plugin")
