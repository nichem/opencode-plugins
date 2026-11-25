// Isolated config/database, artificial sessions, fake credentials and a local model only.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCode } from "@opencode/client";
import { SkillsRPC } from "../src/rpc.js";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the OpenCode 2.4.1+ executable path");
const plugin = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(join(plugin, "node_modules", ".skills-smoke-"));
const project = join(root, "project"), config = join(root, "config", "opencode");
for (const directory of [project, config, join(root, "home")]) await mkdir(directory, { recursive: true });
const configuration = { plugins: [join(plugin, "tests", "mock-provider"), plugin] };
for (const file of [join(config, "opencode.json"), join(project, "opencode.json")]) await writeFile(file, JSON.stringify(configuration));
await writeFile(join(config, "cli.json"), "{}");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^OPENCODE|^GIT_/i.test(key)));
Object.assign(env, { XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG_DIR: config, OPENCODE_TEST_HOME: join(root, "home"), OPENCODE_DB: join(root, "smoke.db"),
    GIT_CONFIG_GLOBAL: join(root, "empty.gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
await writeFile(env.GIT_CONFIG_GLOBAL, "");
for (const args of [["init", "--quiet"], ["add", "--", "opencode.json"],
    ["-c", "user.name=Skills Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Fixture"]])
    execFileSync("git", args, { cwd: project, env, windowsHide: true, stdio: "pipe" });
const probe = createServer();
await new Promise(done => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise(done => probe.close(done));
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
child.stdout.on("data", chunk => { logs += chunk; });
child.stderr.on("data", chunk => { logs += chunk; });
const headers = () => {
    const password = /server password (\S+)/.exec(logs)?.[1];
    return password ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {};
};
const client = OpenCode.make({ baseUrl, fetch: (request, init) => fetch(request, {
    ...init, headers: new Headers({ ...Object.fromEntries(new Headers(init?.headers)), ...headers() }),
}) });
const location = { directory: project }, options = { location, signal: AbortSignal.timeout(90000) };
const rpc = client.rpc(SkillsRPC);
async function api(path, body, method = body === undefined ? "GET" : "POST") {
    const url = new URL(path, baseUrl); url.searchParams.set("location[directory]", project);
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json", ...headers() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Isolated API failed: ${method} ${path} (${response.status})`);
    if (response.status === 204) return;
    const value = await response.json(); return value?.data ?? value;
}
async function prompt(sessionID) {
    await api(`/api/session/${sessionID}/prompt`, { text: "Inspect the artificial fixture tools", resume: true });
    for (let attempt = 0; attempt < 150; attempt++) {
        const context = await api(`/api/session/${sessionID}/context`);
        if (JSON.stringify(context).includes("Fixture done:")) return context;
        await delay(100);
    }
    throw new Error("Fixture model did not finish");
}
async function afterReload(sessionID) {
    await client.location.reload({ signal: AbortSignal.timeout(15000) });
    for (let attempt = 0; attempt < 100; attempt++) {
        try { return await rpc.state({ sessionID }, { location, signal: AbortSignal.timeout(2000) }); }
        catch (error) { if (attempt === 99) throw error; }
        await delay(100);
    }
}
try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const plugins = await api("/api/plugin");
            if (plugins.some(p => p.state.status === "failed")) throw new Error("Fixture plugin failed to load: " + JSON.stringify(plugins.filter(p => p.state.status === "failed")));
            if (["skills-fixture", "opencode-deepseek-skills"].every(id => plugins.some(p => p.id === id && p.state.status === "active"))) { ready = true; break; }
        } catch (error) { if (attempt === 99 || error.message.startsWith("Fixture plugin failed to load")) throw error; }
        if (child.exitCode !== null) throw new Error("Isolated server exited");
        await delay(200);
    }
    assert.ok(ready);
    assert.equal((await api("/api/integration/dss")).name, "DSS (DeepSeek Skills)");
    const sharedSkills = await api("/api/skill");
    assert.ok(!sharedSkills.some(skill => skill.id.startsWith("deepseek-")), "Skills leaked into the shared catalog");
    await client.integration.connect.key({ integrationID: "dss", key: "fixture-search-key-1", location });
    const off = await api("/api/session", { model: { providerID: "skills-fixture", id: "inspect" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] });
    assert.equal((await rpc.state({ sessionID: off.id }, options)).enabled, false);
    const offContext = await prompt(off.id);
    assert.ok(JSON.stringify(offContext).includes("Fixture done: hidden"));
    console.log("PASS: native host loads both integrations; default-off session and shared skill catalog expose no DeepSeek skills.");
    const on = await rpc.create({ model: { providerID: "skills-fixture", id: "execute" } }, options);
    assert.equal(on.enabled, true);
    const before = await api(`/api/session/${on.sessionID}/context`);
    assert.ok(!JSON.stringify(before).includes("Fixture done:"), "Homepage command must not run the model");
    await api(`/api/session/${on.sessionID}`, { permissions: [{ action: "*", resource: "*", effect: "allow" }] }, "PATCH");
    const context = await prompt(on.sessionID);
    const toolParts = context.flatMap(message => message.content ?? []).filter(part => part.type === "tool");
    assert.ok(toolParts.some(part => part.name === "deepseek_skill" || part.tool === "deepseek_skill" || JSON.stringify(part).includes("deepseek_skill")));
    assert.ok(JSON.stringify(context).includes("Simulated Search response"), "Skill loading must lead to independent Search execution");
    assert.equal((await rpc.state({ sessionID: off.id }, options)).enabled, false);
    console.log("PASS: homepage-created session is enabled before its first model turn; SKILL.md loads then Search executes with DSS.");
    await rpc.toggle({ sessionID: on.sessionID }, options);
    assert.equal((await rpc.state({ sessionID: on.sessionID }, options)).enabled, false);
    assert.equal((await afterReload(on.sessionID)).enabled, false);
    await rpc.toggle({ sessionID: on.sessionID }, options);
    assert.equal((await afterReload(on.sessionID)).enabled, true);
    console.log("PASS: session state persists through host reload; unrelated sessions remain off.");
} finally {
    child.kill();
    await new Promise(done => { if (child.exitCode !== null) return done(); child.once("exit", done); setTimeout(done, 5000).unref(); });
    assert.ok(resolve(root).startsWith(resolve(join(plugin, "node_modules")) + sep));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
