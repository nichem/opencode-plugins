import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { readFileSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import * as module from "node:module"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { Host } from "@opencode/plugin/host"

const directory = fileURLToPath(new URL("..", import.meta.url))
const root = await mkdtemp(join(tmpdir(), "opencode-quota-host-"))
const run = promisify(execFile)
const install = process.argv.includes("--install")
let hook
try {
  // Package plugins live in node_modules, where OpenTUI skips JSX compilation.
  // Copy only the distribution files, without the development tsconfig.
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
  let installed = join(root, "node_modules", manifest.name)
  await mkdir(installed, { recursive: true })
  for (const file of ["package.json", ...manifest.files])
    await cp(join(directory, file), join(installed, file), { recursive: true })
  if (install) {
    // Exercise OpenCode's actual npm installer against a Git subdirectory. A
    // reserved build/prepare script must fail here, rather than after release.
    const repository = join(root, "repository")
    await mkdir(repository)
    await cp(installed, join(repository, manifest.name), { recursive: true })
    const gitConfig = join(root, "gitconfig")
    await writeFile(gitConfig, "")
    const gitOptions = { cwd: repository, windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitConfig } }
    for (const args of [["init", "--quiet"], ["add", "--", manifest.name],
      ["-c", "user.name=Quota Fixture", "-c", "user.email=quota-fixture@example.invalid", "commit", "--quiet", "-m", "Quota fixture"]])
      await run("git", args, gitOptions)
    const { stdout: revision } = await run("git", ["rev-parse", "HEAD"], gitOptions)
    const spec = `git+${pathToFileURL(repository).href}#${revision.trim()}::path:${manifest.name}`
    // Npm's global runtime retains handles. Run it in an isolated child and
    // exit after flushing its result, without sharing any development modules.
    const source = `
      import { writeSync } from "node:fs";
      import { Npm } from "@opencode/util/npm";
      try {
        writeSync(1, JSON.stringify(await Npm.add(process.argv[1])));
        process.exit(0);
      } catch (error) {
        writeSync(2, [error.name, error.cause?.code, error.cause?.message].filter(Boolean).join(": "));
        process.exit(1);
      }
    `
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", source, spec], {
      cwd: directory, windowsHide: true, timeout: 300000,
      env: { ...process.env, OPENCODE_TEST_HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
        XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") },
    })
    installed = JSON.parse(stdout).directory
    assert.ok(resolve(installed).startsWith(resolve(root) + sep))
  } else {
    await symlink(join(directory, "node_modules"), join(installed, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  }
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
  const entries = Host.resolve({ directory: resolve(installed, "../.."), name: manifest.name })
  assert.ok(entries.server?.endsWith("index.ts"))
  assert.ok(entries.tui?.endsWith("tui.js"))
  const server = await Host.load(entries.server)
  assert.equal(server.default.id, "opencode-quota")
  const tui = await Host.load(entries.tui)
  assert.equal(tui.default.id, "opencode-quota.tui")
  assert.equal(typeof tui.default.setup, "function")
  console.log(install
    ? "PASS: OpenCode 2.1.0 installs a Git subdirectory into an empty cache and loads both packaged entries without development modules"
    : "PASS: OpenCode 2.1.0 host resolves and loads the packaged server and precompiled TUI from node_modules")
} finally {
  hook?.deregister()
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  await rm(root, { recursive: true, force: true })
}
