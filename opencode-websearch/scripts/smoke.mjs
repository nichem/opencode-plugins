// Only artificial sessions, an offline model, and fixture search providers are used.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCode } from "@opencode/client";
import { SearchRPC } from "../src/rpc.js";
import { installPicker, searchConfiguration } from "../src/picker.js";
import { DSS_QUERY_ERROR } from "../src/deepseek.js";

const executable = process.argv[2];
if (!executable) throw new Error("Pass the path to the OpenCode 2.1.0 executable");
const root = mkdtempSync(join(tmpdir(), "opencode-websearch-smoke-"));
const project = join(root, "project"), config = join(root, "config", "opencode");
for (const directory of [project, config, join(root, "home")]) mkdirSync(directory, { recursive: true });
const plugin = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/");
const mockPlugin = `${plugin}/tests/mock-provider`;
const configuration = { plugins: process.argv.includes("--reverse-order") ? [plugin, mockPlugin] : [mockPlugin, plugin] };
writeFileSync(join(config, "opencode.json"), JSON.stringify(configuration));
writeFileSync(join(project, "opencode.json"), JSON.stringify(configuration));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^OPENCODE|^GIT_/i.test(key)));
Object.assign(env, { XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_CONFIG_DIR: config,
    OPENCODE_TEST_HOME: join(root, "home"), OPENCODE_DB: join(root, "smoke.db"),
    GIT_CONFIG_GLOBAL: join(root, "empty.gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
writeFileSync(env.GIT_CONFIG_GLOBAL, "");
function initializeRepository(directory) {
    for (const args of [["init", "--quiet"], ["add", "--", "opencode.json"],
        ["-c", "user.name=Search Fixture", "-c", "user.email=search-fixture@example.invalid", "commit", "--quiet", "-m", "Fixture"]])
        execFileSync("git", args, { cwd: directory, env, windowsHide: true, stdio: "pipe" });
}
initializeRepository(project);
const probe = createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
child.stdout.on("data", chunk => { logs += chunk; });
child.stderr.on("data", chunk => { logs += chunk; });
child.on("error", error => { logs += error.name; });
const headers = () => {
    const password = /server password (\S+)/.exec(logs)?.[1];
    return password ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {};
};
async function api(path, body, directory = project) {
    const url = new URL(path, baseUrl);
    url.searchParams.set("location[directory]", directory);
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    assert.ok(response.ok, `${response.status}: ${text}`);
    const value = text ? JSON.parse(text) : undefined;
    return value?.data ?? value;
}
try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const plugins = await api("/api/plugin");
            const active = plugins.filter(plugin => plugin.state.status === "active").map(plugin => plugin.id);
            if (active.includes("websearch-fixture") && active.includes("opencode-websearch")) { ready = true; break; }
            const failed = plugins.filter(plugin => plugin.state.status === "failed");
            if (failed.length) throw new Error(JSON.stringify(failed));
        } catch (error) { if (attempt === 99) throw error; }
        if (child.exitCode !== null) throw new Error("Isolated server exited");
        await delay(200);
    }
    assert.ok(ready, "Isolated plugins did not become active");
    const client = OpenCode.make({ baseUrl, fetch: (request, init) => fetch(request, {
        ...init, headers: new Headers({ ...Object.fromEntries(new Headers(init?.headers)), ...headers() }),
    }) });
    const endpoint = client.rpc(SearchRPC), options = { location: { directory: project } };
    const rpc = Object.fromEntries(["state", "select"].map(method => [method, async (input, options) => endpoint[method](
        { ...input, sources: await searchConfiguration(client, options.location) }, { ...options, signal: AbortSignal.timeout(15000) })]));
    const select = async (input, requestOptions) => {
        const result = await rpc.select(input, { ...requestOptions, signal: AbortSignal.timeout(15000) });
        if (result.reloadRequired) await client.location.reload({ signal: AbortSignal.timeout(15000) });
        return result;
    };
    const initial = await rpc.state({}, options);
    assert.equal(initial.defaultProvider, "fixture-a");
    assert.ok(initial.providers.some(provider => provider.id === "dss" && !provider.available));
    console.log("PASS: native plugin and RPC load; existing default is preserved; disconnected DSS is disabled.");
    const create = (modelID = "test") => api("/api/session", { title: "Search fixture", model: { providerID: "websearch-fixture", id: modelID },
        permissions: [{ action: "*", resource: "*", effect: "allow" }] });
    const first = await create(), second = await create();
    await select({ providerID: "fixture-b", scope: "session", sessionID: first.id }, options);
    assert.equal((await rpc.state({ sessionID: second.id }, options)).sessionProvider, undefined);
    async function search(sessionID, directory = project) {
        await api(`/api/session/${sessionID}/prompt`, { text: "Run the offline fixture search", resume: true }, directory);
        for (let attempt = 0; attempt < 100; attempt++) {
            const messages = await api(`/api/session/${sessionID}/context`, undefined, directory);
            if (JSON.stringify(messages).includes("Fixture finished")) {
                const tool = messages.flatMap(message => message.content ?? []).find(part => part.type === "tool");
                assert.ok(tool, "Native search tool record missing");
                return tool;
            }
            await delay(100);
        }
        throw new Error("Offline search did not complete");
    }
    const overridden = await search(first.id), ordinary = await search(second.id);
    assert.equal(overridden.state.status, "completed", JSON.stringify(overridden));
    assert.equal(ordinary.state.status, "completed", JSON.stringify(ordinary));
    assert.equal(overridden.state.metadata.provider, "fixture-b");
    assert.ok(JSON.stringify(overridden).includes("fixture-b"), "Session override was not applied by native websearch");
    assert.ok(JSON.stringify(ordinary).includes("fixture-a"), "Session override leaked into another session");
    console.log("PASS: session provider isolation through the real native websearch tool.");
    await assert.rejects(select({ providerID: "random", scope: "session", sessionID: first.id }, options));
    assert.equal((await rpc.state({ sessionID: first.id }, options)).sessionProvider, "fixture-b");
    assert.equal((await rpc.state({}, options)).defaultProvider, "fixture-a");
    console.log("PASS: random cannot be applied at session scope; existing choices are preserved.");
    await client.integration.connect.key({ integrationID: "deepseek", key: "fixture-search-key-1", location: { directory: project } });
    assert.ok((await rpc.state({}, options)).providers.some(provider => provider.id === "dss" && provider.available));
    const dssSession = await create();
    await select({ providerID: "dss", scope: "session", sessionID: dssSession.id }, options);
    const dss = await search(dssSession.id);
    assert.equal(dss.state.status, "completed", JSON.stringify(dss));
    assert.equal(dss.state.metadata.provider, "dss");
    assert.ok(JSON.stringify(dss).includes("Offline DSS result"));
    assert.ok(!JSON.stringify(dss).includes("fixture-search-key"));
    console.log("PASS: DSS uses an isolated OpenCode credential, the official endpoint (mocked), and native provider metadata.");

    const longSession = await create("long-query");
    await select({ providerID: "dss", scope: "session", sessionID: longSession.id }, options);
    const sessionValidation = await search(longSession.id);
    assert.equal(sessionValidation.state.status, "error");
    assert.equal(sessionValidation.state.error.message, DSS_QUERY_ERROR);
    await select({ providerID: "dss", scope: "default" }, options);
    const defaultLongSession = await create("long-query"), defaultValidation = await search(defaultLongSession.id);
    assert.equal(defaultValidation.state.status, "error");
    assert.equal(defaultValidation.state.error.message, DSS_QUERY_ERROR);
    const retrySession = await create("length-retry");
    await search(retrySession.id);
    const retryMessages = await api(`/api/session/${retrySession.id}/context`);
    const retryTools = retryMessages.flatMap(message => message.content ?? []).filter(part => part.type === "tool");
    assert.equal(retryTools.length, 2);
    assert.equal(retryTools[0].state.status, "error");
    assert.equal(retryTools[0].state.error.message, DSS_QUERY_ERROR);
    assert.equal(retryTools[1].state.status, "completed");
    assert.equal(retryTools[1].state.input.query, "offline fixture");
    assert.equal(retryTools[1].state.metadata.provider, "dss");
    const otherLongSession = await create("long-query");
    await select({ providerID: "fixture-b", scope: "session", sessionID: otherLongSession.id }, options);
    const otherLongResult = await search(otherLongSession.id);
    assert.equal(otherLongResult.state.status, "completed");
    assert.equal(otherLongResult.state.metadata.provider, "fixture-b");
    console.log("PASS: DSS validation reaches the model at both scopes, the model shortens its retry, and other providers accept their original query lengths.");
    const denied = await api("/api/session", { title: "Denied search fixture", model: { providerID: "websearch-fixture", id: "test" },
        permissions: [{ action: "websearch", resource: "*", effect: "deny" }] });
    await select({ providerID: "fixture-b", scope: "session", sessionID: denied.id }, options);
    const deniedResult = await search(denied.id);
    assert.equal(deniedResult.state.status, "error");
    assert.ok(!JSON.stringify(deniedResult).includes("Result via fixture-b"));
    console.log("PASS: the real websearch deny rule is still enforced for session overrides.");
    await select({ providerID: "fixture-b", scope: "default" }, options);
    assert.equal((await rpc.state({}, { location: { directory: project }, signal: AbortSignal.timeout(15000) })).defaultProvider, "fixture-b");
    console.log("PASS: project preference survives a real server location reload.");
    const fresh = { location: { directory: project }, signal: AbortSignal.timeout(15000) };
    await select({ providerID: "random", scope: "default" }, fresh);
    const fallback = await api("/api/websearch", { query: "rate-fixture" });
    assert.equal(fallback.providerID, "fixture-b");
    console.log("PASS: native random recognizes provider rate limits and switches to the remaining available provider.");
    const disabledProject = join(root, "disabled-project");
    mkdirSync(disabledProject);
    writeFileSync(join(disabledProject, "opencode.json"), JSON.stringify({
        plugins: [{ package: `${plugin}/tests/mock-provider`, options: { preserveDefault: true } }, plugin], websearch: false,
    }));
    initializeRepository(disabledProject);
    const disabledOptions = { location: { directory: disabledProject }, signal: AbortSignal.timeout(15000) };
    const disabledSession = await api("/api/session", { title: "Disabled search fixture", location: { directory: disabledProject },
        model: { providerID: "websearch-fixture", id: "test" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] }, disabledProject);
    const disabledTool = await search(disabledSession.id, disabledProject);
    assert.equal(disabledTool.state.status, "error", JSON.stringify(disabledTool));
    await select({ providerID: "fixture-b", scope: "default" }, disabledOptions);
    const enabledSession = await api("/api/session", { title: "Explicit enable fixture",
        location: { directory: disabledProject }, model: { providerID: "websearch-fixture", id: "test" },
        permissions: [{ action: "*", resource: "*", effect: "allow" }] }, disabledProject);
    const enabledTool = await search(enabledSession.id, disabledProject);
    assert.equal(enabledTool.state.status, "completed", JSON.stringify(enabledTool));
    assert.equal(enabledTool.state.metadata.provider, "fixture-b");
    console.log("PASS: explicit disabled search is preserved until a default is deliberately saved to the project config.");

    const otherProject = join(root, "other-project");
    mkdirSync(otherProject);
    writeFileSync(join(otherProject, "opencode.json"), JSON.stringify(configuration));
    initializeRepository(otherProject);
    const otherSession = await api("/api/session", { title: "Cross-directory picker fixture", location: { directory: otherProject },
        model: { providerID: "websearch-fixture", id: "test" } }, otherProject);
    const mainConfig = readFileSync(join(project, "opencode.json"), "utf8");
    let command;
    const notices = [];
    installPicker({ client, location: undefined, data: { location: { default: () => ({ directory: project }) } },
        keymap: { layer: factory => { command = factory().commands[0]; } },
        ui: { router: { current: () => ({ type: "session", sessionID: otherSession.id }) }, toast: { show: notice => notices.push(notice) } } },
    async () => ({ providerID: "fixture-b", scope: "default" }));
    await command.run();
    assert.equal(notices.at(-1)?.variant, "success", JSON.stringify(notices));
    assert.equal(readFileSync(join(project, "opencode.json"), "utf8"), mainConfig);
    assert.equal(JSON.parse(readFileSync(join(otherProject, "opencode.json"), "utf8")).websearch.provider, "fixture-b");
    assert.equal((await api("/api/websearch", { query: "offline fixture" }, otherProject)).providerID, "fixture-b");
    await assert.rejects(rpc.select({ providerID: "fixture-a", scope: "default", sessionID: otherSession.id }, options),
        error => error.type === "selection");
    assert.equal(readFileSync(join(project, "opencode.json"), "utf8"), mainConfig);
    console.log("PASS: the actual picker uses the active session directory; the server rejects a stale or mismatched session location.");

    mkdirSync(join(project, ".opencode"));
    const nestedConfig = join(project, ".opencode", "opencode.json");
    writeFileSync(nestedConfig, JSON.stringify({ websearch: { provider: "fixture-a" } }));
    await client.location.reload({ signal: AbortSignal.timeout(15000) });
    assert.equal((await rpc.state({}, options)).defaultProvider, "fixture-a");
    await select({ providerID: "fixture-b", scope: "default" }, options);
    assert.equal((await rpc.state({}, options)).defaultProvider, "fixture-b");
    assert.equal((await api("/api/websearch", { query: "offline fixture" })).providerID, "fixture-b");
    assert.equal(readFileSync(join(project, "opencode.json"), "utf8"), mainConfig);
    assert.equal(JSON.parse(readFileSync(nestedConfig, "utf8")).websearch.provider, "fixture-b");
    console.log("PASS: saving updates the higher-priority .opencode configuration, and the real search uses the saved provider.");

    const childProject = join(project, "child-project"), parentConfig = readFileSync(nestedConfig, "utf8");
    mkdirSync(childProject);
    writeFileSync(join(childProject, "opencode.json"), JSON.stringify(configuration));
    initializeRepository(childProject);
    const childOptions = { location: { directory: childProject } };
    assert.equal((await rpc.state({}, childOptions)).defaultProvider, "fixture-b");
    await select({ providerID: "fixture-a", scope: "default" }, childOptions);
    assert.equal((await api("/api/websearch", { query: "offline fixture" }, childProject)).providerID, "fixture-a");
    assert.equal(readFileSync(nestedConfig, "utf8"), parentConfig);
    assert.equal(JSON.parse(readFileSync(join(childProject, ".opencode", "opencode.jsonc"), "utf8")).websearch.provider, "fixture-a");
    console.log("PASS: inherited .opencode selections are overridden locally without changing the parent project.");

    const globalDisabledProject = join(root, "global-disabled-project");
    mkdirSync(globalDisabledProject);
    writeFileSync(join(globalDisabledProject, "opencode.json"), JSON.stringify(configuration));
    initializeRepository(globalDisabledProject);
    writeFileSync(join(config, "opencode.json"), JSON.stringify({ ...configuration, websearch: false }));
    await client.location.reload({ signal: AbortSignal.timeout(15000) });
    const globalDisabledOptions = { location: { directory: globalDisabledProject } };
    const globalDisabledSession = await api("/api/session", { title: "Inherited disabled fixture", location: { directory: globalDisabledProject },
        model: { providerID: "websearch-fixture", id: "test" }, permissions: [{ action: "*", resource: "*", effect: "allow" }] }, globalDisabledProject);
    assert.equal((await rpc.state({ sessionID: globalDisabledSession.id }, globalDisabledOptions)).enabled, false);
    await assert.rejects(select({ providerID: "fixture-b", scope: "session", sessionID: globalDisabledSession.id }, globalDisabledOptions),
        error => error.type === "selection");
    const inheritedDisabledTool = await search(globalDisabledSession.id, globalDisabledProject);
    assert.equal(inheritedDisabledTool.state.status, "error");
    await select({ providerID: "fixture-b", scope: "default", sessionID: globalDisabledSession.id }, globalDisabledOptions);
    assert.equal((await rpc.state({ sessionID: globalDisabledSession.id }, globalDisabledOptions)).enabled, true);
    assert.equal((await api("/api/websearch", { query: "offline fixture" }, globalDisabledProject)).providerID, "fixture-b");
    console.log("PASS: global disable is reflected by the picker and rejects session selection; only an explicit project default enables search.");

    const disabledDefault = { plugins: configuration.plugins.map(entry => entry === mockPlugin
        ? { package: entry, options: { defaultSelection: false } } : entry) };
    writeFileSync(join(config, "opencode.json"), JSON.stringify(disabledDefault));
    writeFileSync(join(project, "opencode.json"), JSON.stringify(disabledDefault));
    writeFileSync(nestedConfig, "{}");
    await client.location.reload({ signal: AbortSignal.timeout(15000) });
    assert.equal((await rpc.state({}, options)).enabled, false);
    await assert.rejects(select({ providerID: "fixture-b", scope: "session", sessionID: first.id }, options),
        error => error.type === "selection");
    console.log(`PASS: plugin default values, including false, are observed after all transforms (${process.argv.includes("--reverse-order") ? "picker first" : "picker last"}).`);
} finally {
    child.kill("SIGKILL");
    writeFileSync(join(root, "server.log"), logs.replace(/server password \S+/g, "server password [REDACTED]"));
    console.log(`Isolated verification directory: ${root}`);
}
