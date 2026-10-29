import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entryCheck = spawnSync(process.execPath, ["--check", fileURLToPath(new URL("../index.js", import.meta.url))], { stdio: "inherit" });
if (entryCheck.error) throw entryCheck.error;
if (entryCheck.status !== 0) process.exit(entryCheck.status ?? 1);

for (const directory of ["src", "scripts", "tests"]) {
    const root = new URL(`../${directory}/`, import.meta.url);
    for (const name of readdirSync(root, { recursive: true })) {
        if (!/\.(?:js|mjs)$/.test(name)) continue;
        const result = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(name.replaceAll("\\", "/"), root))], { stdio: "inherit" });
        if (result.error) throw result.error;
        if (result.status !== 0) process.exit(result.status ?? 1);
    }
}
console.log("JavaScript syntax checks passed.");
