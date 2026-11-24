import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(directory, "tests", "compat", "opentui-0.9.4");
const testFiles = ["tests/thinking.ui.mjs", "tests/native.ui.tsx"];
const testArgs = ["test", "--conditions=browser", "--preload", "@opentui/solid/preload",
    ...testFiles.map(file => `./${file}`), ...process.argv.slice(2)];
const npmCLI = process.env.npm_execpath;
assert.ok(npmCLI, "Run this matrix with npm run test:ui.");

async function run(command, args, cwd) {
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
        child.once("error", reject);
        child.once("exit", (code, signal) => code === 0 ? resolve()
            : reject(new Error(`${command} failed (${signal ?? code}).`)));
    });
}

async function test(cwd, expected) {
    // A version label alone must never let the old renderer stand in for 0.9.4.
    for (const name of ["@opentui/core", "@opentui/solid", "solid-js"]) {
        const installed = JSON.parse(await readFile(join(cwd, "node_modules", name, "package.json"), "utf8"));
        assert.equal(installed.version, expected[name], `${name} version in ${cwd}`);
    }
    console.log(`\nUI compatibility: OpenTUI ${expected["@opentui/core"]}`);
    await run("bun", testArgs, cwd);
}

const baseline = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
await test(directory, baseline.devDependencies);

const temporary = await realpath(tmpdir());
const root = await mkdtemp(join(temporary, "opencode-ui-matrix-"));
try {
    for (const file of ["package.json", "package-lock.json"])
        await cp(join(fixture, file), join(root, file));
    // Stage only this plugin and its artificial UI fixtures, never host config or transcripts.
    for (const file of ["tui.js", "src", ...testFiles]) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await cp(join(directory, file), join(root, file), { recursive: true });
    }
    await run(process.execPath, [npmCLI, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], root);
    const modern = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
    await test(root, modern.dependencies);
} finally {
    const target = await realpath(root);
    assert.equal(dirname(target), temporary);
    assert.ok(basename(target).startsWith("opencode-ui-matrix-"));
    await rm(target, { recursive: true, force: true });
}
