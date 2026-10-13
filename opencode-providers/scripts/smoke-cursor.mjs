// Disposable host verification only. Never installs a local path into the user's OpenCode.
// Usage: node scripts/smoke-cursor.mjs /absolute/path/to/opencode.exe
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const executable = process.argv[2];
if (!executable) throw new Error("Pass an OpenCode 2.x executable");
const root = mkdtempSync(join(tmpdir(), "opencode-cursor-smoke-"));
const project = join(root, "project"), config = join(root, "config", "opencode"), home = join(root, "home");
for (const dir of [project, config, home]) mkdirSync(dir, { recursive: true });
writeFileSync(join(config, "opencode.json"), JSON.stringify({ plugins: [{
    package: fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/"),
    options: { providers: { qoder: { enabled: false }, krill: { enabled: false }, cursor: { discoverModels: false } } },
}] }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^OPENCODE|^QODER|^CURSOR/i.test(key)));
Object.assign(env, {
    HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG_DIR: config, OPENCODE_DB: join(root, "smoke.db"),
});
const probe = createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
child.on("error", error => { logs += String(error); });
async function api(path, body) {
    const url = new URL(path, `http://127.0.0.1:${port}`);
    url.searchParams.set("location[directory]", project);
    const password = /server password (\S+)/.exec(logs)?.[1];
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...(password ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    return { ok: response.ok, data: data.data ?? data };
}
try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
        try {
            const result = await api("/api/plugin");
            if (result.ok && result.data.some(p => p.id === "opencode-providers" && p.state.status === "active")) { ready = true; break; }
        } catch {}
        if (child.exitCode !== null) throw new Error("Isolated OpenCode exited");
        await delay(200);
    }
    assert.ok(ready, "Cursor plugin did not load");
    const integration = await api("/api/integration/cursor");
    assert.ok(integration.ok);
    assert.deepEqual(integration.data.methods.map(m => m.type).sort(), ["key", "oauth"]);
    const provider = await api("/api/provider/cursor");
    assert.ok(provider.ok);
    assert.equal(provider.data.id, "cursor");
    const models = await api("/api/model");
    assert.ok(models.ok);
    assert.deepEqual(models.data.filter(model => model.providerID === "cursor"), []);
    console.log("PASS: real OpenCode 2.x registered Cursor and browser/key login; disabled discovery left no models or Auto fallback.");
    console.log("No real credential, agent document or Cursor generation request was used.");
} finally {
    child.kill("SIGKILL");
    writeFileSync(join(root, "server.log"), logs.replace(/server password \S+/g, "server password [REDACTED]"));
    console.log(`Isolated verification data: ${root}`);
}
