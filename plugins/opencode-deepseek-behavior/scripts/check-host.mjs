import assert from "node:assert/strict"
import { mkdtemp, mkdir, cp, symlink, realpath, rm } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { registerHooks, stripTypeScriptTypes } from "node:module"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { join, resolve, sep } from "node:path"
import { Host } from "@opencode/plugin/host"

const directory = fileURLToPath(new URL("..", import.meta.url))
const temporary = await realpath(tmpdir())
const root = await mkdtemp(join(temporary, "opencode-deepseek-behavior-host-"))
let hook
try {
  const installed = join(root, "node_modules", "opencode-deepseek-behavior")
  await mkdir(installed, { recursive: true })
  for (const file of ["package.json", "index.ts", "tui.js", "src"])
    await cp(join(directory, file), join(installed, file), { recursive: true })
  await symlink(join(directory, "node_modules"), join(installed, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  // Node normally rejects TS in node_modules; the OpenCode/Bun loader strips it.
  hook = registerHooks({ load(url, context, nextLoad) {
    if (url.startsWith(pathToFileURL(installed).href + "/") && url.endsWith(".ts"))
      return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")) }
    return nextLoad(url, context)
  } })
  const entries = Host.resolve({ directory: root, name: "opencode-deepseek-behavior" })
  assert.ok(entries.server?.endsWith("index.ts"))
  assert.ok(entries.tui?.endsWith("tui.js"))
  for (const [entry, id] of [[entries.server, "opencode-deepseek-behavior"], [entries.tui, "opencode-deepseek-behavior.tui"]]) {
    const loaded = await Host.load(entry)
    assert.equal(loaded.default.id, id)
    assert.equal(typeof loaded.default.setup, "function")
  }
  console.log("PASS: OpenCode 2.2.0 host loads the packaged server and precompiled sidebar from node_modules")
} finally {
  hook?.deregister()
  assert.ok(resolve(root).startsWith(resolve(temporary) + sep))
  await rm(root, { recursive: true, force: true })
}
