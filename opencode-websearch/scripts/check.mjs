import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
for (const file of ["index.js", "tui.js", ...readdirSync("src").filter(name => name.endsWith(".js")).map(name => `src/${name}`)])
    execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
