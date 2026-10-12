// Usage: node scripts/smoke.mjs /absolute/path/to/opencode2.exe
// Isolated config/database: list models, then exercise the missing-PAT path.
// No real credentials or Qoder network requests are used.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the path to an OpenCode 2.x executable");
const root = mkdtempSync(join(tmpdir(), "opencode-providers-smoke-"));
const project = join(root, "project");
const config = join(root, "config", "opencode");
mkdirSync(project, { recursive: true });
mkdirSync(join(root, "home"), { recursive: true });
mkdirSync(config, { recursive: true });
writeFileSync(join(config, "opencode.json"), JSON.stringify({
    plugins: [{ package: fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/"), options: { providers: { qoder: { discoverModels: false } } } }],
}));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^OPENCODE|^QODER/i.test(key)));
Object.assign(env, {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_TEST_HOME: join(root, "home"),
    OPENCODE_DB: join(root, "smoke.db"),
});
const result = spawnSync(executable, ["models", "--standalone", "--print-logs", "--log-level", "debug"], {
    cwd: project, env, windowsHide: true, encoding: "utf8", timeout: 60000, killSignal: "SIGKILL",
});
if (result.error) throw result.error;
if (!result.stdout.includes("qoder/auto")) {
    for (const args of [["api", "--standalone", "config.get"], ["api", "--standalone", "plugin.list"]]) {
        const diagnostic = spawnSync(executable, args, { cwd: project, env, windowsHide: true, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
        console.error(diagnostic.stdout, diagnostic.stderr);
    }
}
assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(result.stdout, /qoder\/auto/, result.stderr);
assert.match(result.stdout, /qoder\/qmodel_38max/);
const request = spawnSync(executable, [
    "api", "--standalone", "POST", "/api/experimental/generate", "--data",
    JSON.stringify({ prompt: "hello", model: { providerID: "qoder", id: "auto" } }),
], { cwd: project, env, windowsHide: true, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
if (request.error) throw request.error;
assert.match(request.stdout + request.stderr, /Qoder PAT not set/, request.stdout + request.stderr);
console.log("OpenCode 2.x loaded opencode-providers and listed both Qoder CN models.");
console.log("The real model request reached the Qoder authentication check without sending a Qoder API request.");
console.log(`Isolated verification data: ${root}`);
