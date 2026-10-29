import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, symlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve, sep } from "node:path";
import { Host } from "@opencode/plugin/host";

const directory = fileURLToPath(new URL("..", import.meta.url));
const temporary = await realpath(tmpdir());
const root = await mkdtemp(join(temporary, "opencode-websearch-host-"));
try {
    const installed = join(root, "node_modules", "opencode-websearch");
    await mkdir(installed, { recursive: true });
    for (const file of ["package.json", "index.js", "tui.js", "src"])
        await cp(join(directory, file), join(installed, file), { recursive: true });
    await symlink(join(directory, "node_modules"), join(installed, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const entries = Host.resolve({ directory: root, name: "opencode-websearch" });
    assert.ok(entries.server?.endsWith("index.js"));
    assert.ok(entries.tui?.endsWith("tui.js"));
    for (const [entry, id] of [[entries.server, "opencode-websearch"], [entries.tui, "opencode-websearch.tui"]]) {
        const plugin = await Host.load(entry);
        assert.equal(plugin.default.id, id);
        assert.equal(typeof plugin.default.setup, "function");
    }
    assert.equal(typeof (await Host.load(pathToFileURL(join(installed, "src", "dialog.js")).href)).showPicker, "function");
    console.log("PASS: OpenCode 2.1.0 host loads both packaged JavaScript entries and the dialog from node_modules.");
} finally {
    assert.ok(resolve(root).startsWith(resolve(temporary) + sep));
    await rm(root, { recursive: true, force: true });
}
