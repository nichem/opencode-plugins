import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
import { skillIDs } from "../src/catalog.js";
import { Host } from "@opencode/plugin/host";

const root = fileURLToPath(new URL("..", import.meta.url));
for (const directory of [root, join(root, "src"), join(root, "scripts"), join(root, "tests")]) {
    for (const file of await readdir(directory)) if (/\.m?js$/.test(file))
        execFileSync(process.execPath, ["--check", join(directory, file)], { stdio: "inherit", windowsHide: true });
}
for (const id of skillIDs) assert.match(await readFile(join(root, "skills", id, "SKILL.md"), "utf8"), new RegExp(`name: deepseek-${id}`));
for (const file of ["index.js", "tui.js"]) {
    const plugin = await Host.load(new URL(`../${file}`, import.meta.url).href);
    assert.equal(typeof plugin.default.setup, "function");
}
console.log("PASS: JavaScript syntax, five skill documents, and both OpenCode plugin entries.");
