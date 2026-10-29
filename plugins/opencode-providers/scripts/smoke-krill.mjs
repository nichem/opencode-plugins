import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the OpenCode executable path");
const root = mkdtempSync(join(tmpdir(), "opencode-krill-smoke-"));
const project = join(root, "project"), config = join(root, "config", "opencode");
for (const dir of [project, config, join(root, "home")]) mkdirSync(dir, { recursive: true });
const requests = [];
const mock = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    requests.push({ path: req.url, auth: req.headers.authorization, body });
    const response = { id: "resp_smoke", object: "response", created_at: 1, model: body.model, status: "completed",
        output: [{ id: "msg_smoke", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "krill smoke ok", annotations: [] }] }],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
    if (!body.stream) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(response)); return; }
    res.setHeader("Content-Type", "text/event-stream");
    for (const event of [
        { type: "response.created", response: { ...response, output: [], status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...response.output[0], content: [] } },
        { type: "response.output_text.delta", item_id: "msg_smoke", output_index: 0, content_index: 0, delta: "krill smoke ok" },
        { type: "response.output_item.done", output_index: 0, item: response.output[0] },
        { type: "response.completed", response },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
});
await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
const mockURL = `http://127.0.0.1:${mock.address().port}/codex/v1`;
const plugin = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/");
const settings = { plugins: [{ package: plugin, options: { providers: { qoder: { enabled: false }, krill: { baseURL: mockURL, discoverModels: false } } } }] };
for (const dir of [config, project]) writeFileSync(join(dir, "opencode.json"), JSON.stringify(settings));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^OPENCODE|^QODER|^KRILL/i.test(key)));
Object.assign(env, { XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"), OPENCODE_CONFIG_DIR: config, OPENCODE_TEST_HOME: join(root, "home"), OPENCODE_DB: join(root, "smoke.db") });
const probe = createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
child.stdout.on("data", chunk => { logs += chunk }); child.stderr.on("data", chunk => { logs += chunk });
child.on("error", error => { logs += String(error) });
async function api(path, body) {
    const url = new URL(path, `http://127.0.0.1:${port}`); url.searchParams.set("location[directory]", project);
    const password = /server password (\S+)/.exec(logs)?.[1];
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json",
        ...(password ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const text = await response.text(); assert.ok(response.ok, `${response.status}: ${text}`);
    if (!text) return;
    const data = JSON.parse(text); return data.data ?? data;
}
try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
        try { const plugins = await api("/api/plugin"); if (plugins.some(p => p.id === "opencode-providers" && p.state.status === "active")) { ready = true; break; } } catch {}
        if (child.exitCode !== null) throw new Error("Server exited");
        await delay(200);
    }
    assert.ok(ready, "Plugin did not load");
    const integration = await api("/api/integration/krill");
    assert.ok(integration.methods.some(m => m.type === "key"));
    for (const key of ["fake-smoke-a", "fake-smoke-b"]) {
        await api("/api/integration/krill/connect/key", { key });
        const result = await api("/api/experimental/generate", { prompt: "test", model: { providerID: "krill", id: "gpt-6.1-sol" } });
        assert.match(JSON.stringify(result), /krill smoke ok/);
        assert.equal(requests.at(-1).auth, `Bearer ${key}`);
        assert.equal(requests.at(-1).path, "/codex/v1/responses");
        assert.equal(requests.at(-1).body.store, false);
    }
    console.log("PASS: OpenCode 2.x integration, key connection, Responses generation and account switching.");
} finally {
    child.kill("SIGKILL"); mock.closeAllConnections(); mock.close();
    writeFileSync(join(root, "server.log"), logs.replace(/server password \S+/g, "server password [REDACTED]"));
    console.log(`Isolated smoke data: ${root}`);
}
