import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Schema } from "effect";
import { Model, Provider, Credential } from "@opencode/plugin";
import { setupCursor } from "../src/providers/cursor/index.js";
import { connectionAuth, pollLogin } from "../src/providers/cursor/auth.js";
import * as upstream from "../src/providers/cursor/upstream.js";
import { handleInteractionQuery, decodeMessage, buildGitDiffExecMessages, parseExecServerMessage, buildToolCallPart, resolveVariantParameters } from "../src/providers/cursor/vendor/protocol.js";
import { findContinuationSession, sessionManager, buildExecClientMessages, buildCompleteEditReadMessages, shouldContinueProgressOnlyTurn } from "../src/providers/cursor/vendor/protocol.js";
import { remapCorrelatedEditWriteForCatalog, remapEditToolsForCatalog, buildOpenCodeInteractionGuidance } from "../src/providers/cursor/vendor/protocol.js";
import { followHostPlanAgent, getActiveCursorMode, takeActiveCursorModeReminder, takeHostPlanAgentNote, clearActiveCursorMode } from "../src/providers/cursor/vendor/protocol.js";
import { resolveTurnToolState, refreshHeldSessionToolCatalog, missingRequiredToolArguments } from "../src/providers/cursor/vendor/protocol.js";

test("tool schemas and descriptions refresh on new turns and held continuations", async () => {
    const tool = (name, required) => ({ type: "function", name, description: `Requires ${required}`,
        inputSchema: { type: "object", required: [required], properties: { [required]: { type: "string" } } } });
    const old = tool("fixture_lookup", "oldArg"), current = tool("fixture_lookup", "newArg");
    for (const sessionKey of ["schema-refresh-fixture", undefined]) {
        const initial = await resolveTurnToolState({ sessionKey, incomingTools: [old], isCompaction: false });
        const session = { openCodeSessionId: sessionKey, toolCatalog: initial.advertisedTools, requestContext: {} };
        const before = structuredClone(current);
        await refreshHeldSessionToolCatalog(session, { tools: [current] });
        const actual = session.toolCatalog.find(item => item.name === current.name);
        assert.deepEqual(actual.inputSchema, current.inputSchema);
        assert.equal(actual.description, current.description);
        assert.deepEqual(missingRequiredToolArguments(actual, { newArg: "value" }), []);
        assert.deepEqual(missingRequiredToolArguments(actual, { oldArg: "value" }), ["newArg"]);
        assert.ok(JSON.stringify(session.toolDescriptors).includes("newArg"));
        assert.ok(!JSON.stringify(session.toolDescriptors).includes("oldArg"));
        assert.deepEqual(current, before);
        const third = tool("fixture_lookup", "latestArg");
        const next = await resolveTurnToolState({ sessionKey, incomingTools: [third, tool("added_fixture", "value")], isCompaction: false });
        assert.deepEqual(next.advertisedTools.find(item => item.name === third.name).inputSchema, third.inputSchema);
        assert.equal(next.advertisedTools.length, 2);
        // Shrinking the permitted list never enables the retained cached tool.
        await refreshHeldSessionToolCatalog(session, { tools: [third] });
        assert.deepEqual([...session.permittedToolNames], [third.name]);
        await refreshHeldSessionToolCatalog(session, { tools: [third], toolChoice: { type: "none" } });
        assert.equal(session.allowTools, false);
        assert.equal(session.permittedToolNames.size, 0);
    }
    const empty = await resolveTurnToolState({ sessionKey: "schema-refresh-fixture", incomingTools: [], isCompaction: false });
    assert.deepEqual(empty.advertisedTools, []);
    assert.equal(empty.allowTools, false);
    const compact = await resolveTurnToolState({ incomingTools: [current], isCompaction: true });
    assert.equal(compact.allowTools, false);
});

test("host agent transitions never inject Cursor execution or planning instructions", t => {
    const key = "mode-transition-fixture";
    t.after(() => clearActiveCursorMode(key));
    for (const target of ["readonly-review-fixture", "build", "custom-fixture"]) {
        clearActiveCursorMode(key);
        assert.equal(followHostPlanAgent(key, undefined, "plan"), "entered");
        assert.equal(getActiveCursorMode(key), "plan");
        assert.equal(takeActiveCursorModeReminder(key, { hostAgent: "plan", advertisedTools: ["read", "plan_exit"] }), undefined);
        assert.equal(takeHostPlanAgentNote(key, "fixture-conversation", "plan", [{ name: "plan_exit" }], { hostPlanFile: "/fixture/plan.md" }), undefined);
        assert.equal(followHostPlanAgent(key, "plan", target), "left");
        assert.equal(getActiveCursorMode(key), "agent");
        for (let turn = 0; turn < 2; turn++)
            assert.equal(takeActiveCursorModeReminder(key, { hostAgent: target, advertisedTools: ["read"] }), undefined);
    }
    followHostPlanAgent(key, undefined, "plan");
    assert.equal(takeActiveCursorModeReminder(key, { advertisedTools: ["plan_enter"] }), undefined);
});

test("edit conversion refuses disk-dependent mappings and preserves advertised host tools", t => {
    const read = fs.readFileSync, stat = fs.statSync;
    let diskAccesses = 0;
    const forbidden = () => { diskAccesses++; throw new Error("Unexpected disk access"); };
    fs.readFileSync = forbidden; fs.statSync = forbidden;
    t.after(() => { fs.readFileSync = read; fs.statSync = stat; });
    const write = { toolName: "write", resultField: "write_result", args: { path: "/fixture.txt", content: "replacement" } };
    for (const catalog of [["edit"], ["apply_patch"]]) {
        const parsed = structuredClone(write);
        assert.equal(remapCorrelatedEditWriteForCatalog(parsed, catalog, "/fixture.txt", "/"), false);
        remapEditToolsForCatalog(parsed, catalog, "/");
        assert.match(parsed.localError, /disabled/);
        assert.deepEqual(parsed.args, write.args);
    }
    const edit = { toolName: "edit", resultField: "write_result", args: { path: "/fixture.txt", oldString: "before", newString: "after" } };
    const converted = structuredClone(edit);
    remapEditToolsForCatalog(converted, ["apply_patch"], "/");
    assert.match(converted.localError, /requires reading local files/);
    assert.deepEqual(converted.args, {});
    for (const original of [write, edit]) {
        const parsed = structuredClone(original);
        remapCorrelatedEditWriteForCatalog(parsed, ["write", "edit"], "/fixture.txt", "/");
        remapEditToolsForCatalog(parsed, ["write", "edit"], "/");
        assert.deepEqual(parsed, original);
    }
    const creation = structuredClone(write);
    remapEditToolsForCatalog(creation, ["apply_patch"], "/");
    assert.equal(creation.toolName, "apply_patch");
    assert.match(creation.args.patchText, /\*\*\* Add File:/);
    assert.equal(diskAccesses, 0);
});

test("interaction guidance matches disabled native planning and edit conversion", () => {
    for (const names of [["shell"], ["question", "plan_enter", "plan_exit"], ["apply_patch", "cursor_plan_stage"]]) {
        const text = buildOpenCodeInteractionGuidance(names.map(name => ({ name })), false, "/fixture", { allowTools: true });
        assert.match(text, /CreatePlan, SwitchMode and GenerateImage are disabled/);
        assert.doesNotMatch(text, /CreatePlan is accepted|SwitchMode.*also accepted|call native SwitchMode|converted to `apply_patch` automatically|approved SwitchMode/);
        if (names.includes("plan_enter")) assert.match(text, /advertised OpenCode plan_enter/);
        if (names.includes("plan_exit")) assert.match(text, /advertised OpenCode plan_exit/);
        if (names.includes("apply_patch")) assert.match(text, /native edit conversion.*disabled/);
    }
    assert.equal(buildOpenCodeInteractionGuidance([{ name: "shell" }], true, "/fixture"), undefined);
    assert.match(buildOpenCodeInteractionGuidance([{ name: "shell" }], false, "/fixture", { allowTools: false }), /text output only/);
});

test("held Cursor continuation refuses a different account/session before delivering results", t => {
    const original = sessionManager.findByExecIds;
    t.after(() => { sessionManager.findByExecIds = original; });
    const held = { openCodeSessionId: "host-session:cursor:account-a" };
    sessionManager.findByExecIds = (id, execIds) => {
        assert.equal(id, "held-cursor-session"); assert.deepEqual(execIds, [7]);
        return held;
    };
    const results = [{ sessionId: "held-cursor-session", execId: 7 }];
    assert.equal(findContinuationSession(results, held.openCodeSessionId), held);
    for (const key of ["host-session:cursor:account-b", "other-session:cursor:account-a", undefined])
        assert.throws(() => findContinuationSession(results, key), /refusing to deliver/);
    assert.equal(findContinuationSession([], held.openCodeSessionId), undefined);
    sessionManager.findByExecIds = () => undefined;
    assert.equal(findContinuationSession(results, held.openCodeSessionId), undefined);
});

test("read conversion never rereads a file or expands the host-authorized partial result", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-read-fixture-"));
    const file = path.join(directory, "fixture.txt");
    fs.writeFileSync(file, "allowed line\nnot authorized by this read\n");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const original = fs.readFileSync;
    fs.readFileSync = () => { throw new Error("Protocol must not read local file contents"); };
    t.after(() => { fs.readFileSync = original; });
    assert.equal(buildCompleteEditReadMessages(7, file), undefined);
    const frames = buildExecClientMessages({
        execId: 7, resultField: "read_result", toolName: "read", workspaceRoot: directory,
        resultMetadata: { path: file }, output: "allowed line",
    });
    const result = decodeMessage("AgentClientMessage", frames[0]).exec_client_message.read_result.success;
    assert.equal(result.content, "allowed line");
    assert.equal(result.total_lines, 1);
    const denied = buildExecClientMessages({ execId: 8, resultField: "read_result", toolName: "read", workspaceRoot: directory,
        resultMetadata: { path: file }, output: "", error: "Permission denied by host" });
    assert.match(decodeMessage("AgentClientMessage", denied[0]).exec_client_message.read_result.error.error, /Permission denied/);
});

test("progress-only terminal turns never authorize an autonomous follow-up", () => {
    for (const assistantText of ["Checking the workspace", "Let me check the code", "Looking into the issue…", "Done."])
        assert.equal(shouldContinueProgressOnlyTurn({ allowTools: true, advertisedToolCount: 10, pendingExecs: 0,
            emittedHostTools: 0, continuationAttempts: 0, assistantText }), false);
});

function harness() {
    const state = { credential: undefined, connection: undefined, methods: [], models: [], hooks: [], calls: [], resolves: 0, discoveries: 0 };
    const forbidden = new Proxy({}, { get() { throw new Error("Cursor must not access global host behavior"); } });
    const ctx = {
        location: { directory: "C:/fixture/project" },
        tool: forbidden, mcp: forbidden, shell: forbidden, agent: forbidden, model: forbidden, permission: forbidden, event: forbidden, websearch: forbidden,
        integration: {
            async transform(fn) { fn({ update(id, edit) { assert.equal(id, "cursor"); edit({ id }); }, method: { update(value) { state.methods.push(value); } } }); },
            connection: {
                async active(id) { assert.equal(id, "cursor"); return state.connection; },
                async resolve() { state.resolves++; return state.credential; },
            },
        },
        provider: { async transform(fn) { fn({ add(record) {
            Schema.decodeUnknownSync(Provider.Info)(record.info);
            record.models.forEach(model => Schema.decodeUnknownSync(Model.Info)(model));
            state.models.push(record);
        } }); } },
        aisdk: { async hook(name, run, scope) { state.hooks.push({ domain: "aisdk", name, run, scope }); } },
        session: {
            async get() { return { directory: "C:/fixture/actual-session" }; },
            async hook(name, run, scope) { state.hooks.push({ domain: "session", name, run, scope }); },
        },
    };
    const protocol = { ...upstream,
        async fetchModels() { state.discoveries++; return [{ id: "fixture-model", displayName: "Fixture", supportsAgent: true, supportsImages: true, maxContext: 123000, variants: [] }]; },
        createSdk(options) { return { languageModel(modelID) {
            const run = async input => {
                const token = await options.getAccessToken();
                state.calls.push({ options, modelID, input, token });
                return { content: [{ type: "text", text: "fixture reply" }] };
            };
            return { doStream: run, doGenerate: run };
        } }; },
    };
    function connect(id, credential = { type: "key", key: `fixture-${id}` }) {
        state.connection = { type: "credential", id, label: id, method: credential.type };
        state.credential = credential;
    }
    return { ctx, state, protocol, connect };
}

test("Cursor uses only scoped hooks, native schemas, and stored key/OAuth methods", async () => {
    const h = harness();
    await setupCursor(h.ctx, {}, h.protocol);
    assert.deepEqual(h.state.methods.map(x => x.method.type), ["key", "oauth"]);
    assert.equal(h.state.models[0].models[0].id, "default");
    assert.equal(h.state.discoveries, 0);
    for (const hook of h.state.hooks) {
        assert.deepEqual(hook.scope, { providerID: "cursor" });
        for (const providerID of ["qoder", "krill", "other"]) {
            const event = { model: { providerID }, options: { keep: true }, headers: { test: "keep" }, tools: { execute: {} }, system: ["fixture"] };
            const before = structuredClone(event);
            await hook.run(event);
            assert.deepEqual(event, before);
        }
    }
    const fallback = await import(h.state.models[0].info.package.slice(6));
    assert.throws(() => fallback.createCursor({ apiKey: "ignored" }).languageModel("default"), /not active/);
});

test("Cursor discovery is account-bound, failure falls back, invalid config is rejected", async () => {
    const h = harness(); h.connect("a");
    await setupCursor(h.ctx, {}, h.protocol);
    assert.equal(h.state.discoveries, 1);
    assert.equal(h.state.models[0].sourceConnection.id, "a");
    assert.equal(h.state.models[0].models[0].limit.context, 123000);
    const switched = harness(); switched.connect("a");
    switched.protocol.fetchModels = async () => { switched.connect("b"); return [{ id: "wrong-account", variants: [] }]; };
    await setupCursor(switched.ctx, {}, switched.protocol);
    assert.equal(switched.state.models[0].models[0].id, "default");
    for (const options of [{ apiKey: "invalid" }, { token: "invalid" }, { baseURL: "https://example.invalid" }, { discoverModels: "false" }])
        await assert.rejects(setupCursor(h.ctx, options, h.protocol), /Cursor:/);
});

test("cached Cursor model resolves current account, isolates checkpoints, preserves native tool catalog", async () => {
    const h = harness();
    await setupCursor(h.ctx, { discoverModels: false }, h.protocol);
    const event = { model: { providerID: "cursor", id: "default", modelID: "default" }, options: { apiKey: "ignored", accessToken: "ignored", baseURL: "https://invalid" } };
    await h.state.hooks.find(x => x.domain === "aisdk").run(event);
    const input = { prompt: [{ role: "system", content: "host instructions fixture" }], tools: [{ type: "function", name: "execute", inputSchema: { type: "object" } }], headers: { "x-opencode-session-id": "same-session" } };
    const original = structuredClone(input);
    for (const id of ["a", "b"]) {
        h.connect(id);
        await event.language.doGenerate(input);
        const call = h.state.calls.at(-1);
        assert.equal(call.token, `fixture-${id}`);
        assert.equal(call.options.apiKey, undefined);
        assert.equal(call.options.accessToken, undefined);
        assert.equal(call.options.baseURL, undefined);
        assert.deepEqual(call.options.defaultDialect, { filePathKey: "path", shellTool: "shell", skillArgKey: "id" });
        assert.deepEqual(call.input.tools, input.tools);
        assert.deepEqual(call.input.prompt, input.prompt);
    }
    assert.notEqual(h.state.calls[0].input.headers["x-opencode-session-id"], h.state.calls[1].input.headers["x-opencode-session-id"]);
    assert.deepEqual(input, original);
    const callback = h.state.calls[0].options.getAccessToken;
    await assert.rejects(callback(), /account changed/);
    const aborted = new AbortController(); aborted.abort();
    const resolves = h.state.resolves;
    await assert.rejects(event.language.doStream({ ...input, abortSignal: aborted.signal }), { name: "AbortError" });
    assert.equal(h.state.resolves, resolves);
});

test("Cursor ignores environment credentials and refuses environment connections", async t => {
    const previous = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "fixture-environment-key";
    t.after(() => { if (previous === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = previous; });
    const h = harness(), auth = connectionAuth(h.ctx, h.protocol);
    await assert.rejects(auth.read(), /connect/);
    h.state.connection = { type: "env", name: "CURSOR_API_KEY" };
    await assert.rejects(auth.read(), /connect/);
    assert.equal(h.state.resolves, 0);
});

test("OAuth renewal returns native credentials and key exchange uses the fixed Cursor endpoint", async () => {
    const h = harness();
    const token = `fixture.${Buffer.from(JSON.stringify({ exp: 2000000000 })).toString("base64url")}.fixture`;
    h.protocol.renewSessionIfDue = async () => ({ accessToken: token, renewed: true });
    h.protocol.resolveApiKeyToken = async (key, opts) => { assert.equal(key, "crsr_fixture"); assert.equal(opts.baseUrl, "https://api2.cursor.sh"); return { accessToken: "exchanged" }; };
    const auth = connectionAuth(h.ctx, h.protocol);
    const renewed = await auth.refresh({ type: "oauth", methodID: "browser", access: "old", refresh: "old" });
    Schema.decodeUnknownSync(Credential.OAuth)(renewed);
    assert.equal(renewed.access, token); assert.equal(renewed.refresh, token);
    assert.equal(renewed.expires, 2000000000000);
    h.connect("a", { type: "key", key: "crsr_fixture" });
    assert.equal(await auth.token(await auth.read()), "exchanged");
});

test("login polling validates responses, bounds failures, and respects cancellation", async () => {
    const signal = new AbortController().signal;
    let count = 0;
    const result = await pollLogin("fixture", "fixture", signal, async (_url, init) => {
        assert.equal(init.redirect, "error");
        return ++count === 1 ? new Response(null, { status: 404 }) : Response.json({ accessToken: "fixture", refreshToken: "fixture" });
    }, async () => {});
    Schema.decodeUnknownSync(Credential.OAuth)(result);
    await assert.rejects(pollLogin("fixture", "fixture", signal, async () => Response.json({}), async () => {}), /重新连接/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(pollLogin("fixture", "fixture", controller.signal, () => { throw new Error("must not send"); }), { name: "AbortError" });
});

test("Cursor session annotations keep host instructions and tools intact and use actual workspace", async () => {
    const h = harness(); await setupCursor(h.ctx, {}, h.protocol);
    const context = { model: { providerID: "cursor" }, agent: "custom-fixture", options: {}, system: ["host fixture"], messages: [], tools: { execute: {} } };
    await h.state.hooks.find(x => x.name === "context").run(context);
    assert.deepEqual(context.tools, { execute: {} }); assert.deepEqual(context.system, ["host fixture"]);
    assert.equal(context.agent, "custom-fixture"); assert.equal(context.options.opencodeHostAgent, "custom-fixture");
    const request = { model: { providerID: "cursor" }, sessionID: "child", kind: "primary", headers: { "x-session-id": "parent" } };
    await h.state.hooks.find(x => x.name === "model.request").run(request);
    assert.equal(request.headers["x-opencode-session-id"], "child");
    assert.equal(decodeURIComponent(request.headers["x-opencode-directory"]), "C:/fixture/actual-session");
});

test("shipped protocol rejects native plan, mode and image interactions even when tools are advertised", () => {
    for (const [field, name] of [[4, "switch_mode_request_response"], [7, "create_plan_request_response"], [12, "generate_image_request_response"]]) {
        const wire = Uint8Array.from([0x3a, 4, 0x08, 1, field * 8 + 2, 0]);
        const handled = handleInteractionQuery({ id: 1 }, wire, {
            allowTools: true, advertisedTools: new Set(["write", "question", "plan_exit", "cursor_plan_stage", "cursor_image_save"]),
            canBridgeCreatePlan: true, canSaveGeneratedImage: true, workspaceRoot: "/must-not-write", hostAgent: "plan",
        });
        assert.equal(handled.outcome, "rejected");
        const reply = decodeMessage("AgentClientMessage", handled.reply).interaction_response;
        assert.equal(reply.id, 1);
        if (field === 7) assert.match(reply[name].result.error.error, /OpenCode owns/);
        else assert.ok(reply[name].rejected.reason);
        assert.equal(handled.createPlan, undefined); assert.equal(handled.switchMode, undefined);
    }
});

test("shipped protocol rejects direct git execution and maps native shell to host tool calls", async () => {
    const frames = await buildGitDiffExecMessages({ execId: 3, workspaceRoot: "/must-not-run", request: {} });
    const message = decodeMessage("AgentClientMessage", frames[0]);
    assert.match(message.exec_client_control_message.throw.error, /OpenCode shell tool/);
    const parsed = parseExecServerMessage({ id: 4, shell_args: { command: "echo fixture" } }, { filePathKey: "path", shellTool: "shell", skillArgKey: "id" });
    assert.equal(parsed.toolName, "shell");
    const call = buildToolCallPart(parsed, "fixture-session");
    assert.equal(call.toolCallId, "cursor_fixture-session_4"); assert.equal(call.toolName, "shell");
    assert.equal(JSON.parse(call.input).command, "echo fixture");
});

test("real upstream key exchange is cached and forced renewal uses mocked HTTP only", async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const h = harness(); h.connect("real-exchange", { type: "key", key: "crsr_fixture-exchange" });
    let sends = 0;
    globalThis.fetch = async (url, init) => {
        assert.equal(url, "https://api2.cursor.sh/auth/exchange_user_api_key");
        assert.equal(init.headers.Authorization, "Bearer crsr_fixture-exchange");
        sends++;
        const token = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 + sends, fixture: sends })).toString("base64url")}.fixture`;
        return Response.json({ accessToken: token, refreshToken: "fixture-unused" });
    };
    const auth = connectionAuth(h.ctx);
    const saved = await auth.read();
    const first = await auth.token(saved);
    assert.equal(await auth.token(saved), first); assert.equal(sends, 1);
    assert.notEqual(await auth.token(saved, { forceRefresh: true }), first); assert.equal(sends, 2);
});

test("discovered variants reach the protocol only for their owning account", async () => {
    const h = harness(); h.connect("a");
    const raw = { id: "fixture-thinking", displayName: "Thinking", supportsAgent: true, variants: [{
        key: "high", displayName: "High", parameterValues: [{ id: "effort", value: "high" }], isDefaultNonMax: true, isDefaultMax: false,
    }] };
    h.protocol.fetchModels = async () => [raw];
    await setupCursor(h.ctx, {}, h.protocol);
    const info = h.state.models[0].models[0];
    assert.ok(info.variants.length);
    const event = { model: info };
    await h.state.hooks.find(x => x.domain === "aisdk").run(event);
    await event.language.doGenerate({ prompt: [], headers: {} });
    assert.deepEqual(h.state.calls.at(-1).options.availableModels, [raw]);
    const parameters = info.variants[0].settings.cursorVariantParameters;
    assert.deepEqual(resolveVariantParameters(raw, { picked: parameters }), raw.variants[0].parameterValues);
    h.connect("b");
    await event.language.doGenerate({ prompt: [], headers: {} });
    assert.deepEqual(h.state.calls.at(-1).options.availableModels, []);
});
