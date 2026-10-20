import assert from "node:assert/strict"
import { fileURLToPath, pathToFileURL } from "node:url"
import { readFileSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import * as module from "node:module"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { Host } from "@opencode/plugin/host"

const directory = fileURLToPath(new URL("..", import.meta.url))
const root = await mkdtemp(join(tmpdir(), "opencode-quota-host-"))
let hook
try {
  // Package plugins live in node_modules, where OpenTUI skips JSX compilation.
  // Copy only the distribution files, without the development tsconfig.
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
  const installed = join(root, "node_modules", manifest.name)
  await mkdir(installed, { recursive: true })
  for (const file of ["package.json", ...manifest.files])
    await cp(join(directory, file), join(installed, file), { recursive: true })
  await symlink(join(directory, "node_modules"), join(installed, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  // Bun strips types inside installed packages; Node refuses to do so by default.
  // Strip only .ts here, leaving the shipped JavaScript entirely to the host loader.
  if (typeof Bun === "undefined") hook = module.registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith(pathToFileURL(installed).href + "/") && url.endsWith(".ts"))
        return { format: "module", shortCircuit: true,
          source: module.stripTypeScriptTypes(readFileSync(new URL(url), "utf8")) }
      return nextLoad(url, context)
    },
  })
  const entries = Host.resolve({ directory: root, name: manifest.name })
  assert.ok(entries.server?.endsWith("index.ts"))
  assert.ok(entries.tui?.endsWith("tui.js"))
  const server = await Host.load(entries.server)
  assert.equal(server.default.id, "opencode-quota")
  const tui = await Host.load(entries.tui)
  assert.equal(tui.default.id, "opencode-quota.tui")
  assert.equal(typeof tui.default.setup, "function")
  console.log("PASS: OpenCode 2.1.0 host resolves and loads the packaged server and precompiled TUI from node_modules")
} finally {
  hook?.deregister()
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  await rm(root, { recursive: true, force: true })
}
