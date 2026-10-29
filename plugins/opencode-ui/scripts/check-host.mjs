import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import { Host } from "@opencode/plugin/host";

const directory = fileURLToPath(new URL("..", import.meta.url));
const temporary = await realpath(tmpdir());
const root = await mkdtemp(join(temporary, "opencode-ui-host-"));
try {
    const installed = join(root, "node_modules", "opencode-ui");
    await mkdir(installed, { recursive: true });
    for (const file of ["package.json", "tui.js", "src"])
        await cp(join(directory, file), join(installed, file), { recursive: true });
    await symlink(join(directory, "node_modules"), join(installed, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const entries = Host.resolve({ directory: root, name: "opencode-ui" });
    assert.equal(entries.server, undefined);
    assert.ok(entries.tui?.endsWith("tui.js"));
    const plugin = await Host.load(entries.tui);
    assert.equal(plugin.default.id, "opencode-ui.tui");
    assert.equal(typeof plugin.default.setup, "function");
    console.log("PASS: OpenCode 2.1.2 host loads the packaged TUI-only JavaScript plugin.");
} finally {
    assert.ok(resolve(root).startsWith(resolve(temporary) + sep));
    await rm(root, { recursive: true, force: true });
}
