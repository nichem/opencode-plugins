import test from "node:test";
import assert from "node:assert/strict";
import { wrapSearch } from "../src/tool.js";
import { fixture } from "./helpers.mjs";
import { DSS_QUERY_ERROR, QueryValidationError } from "../src/deepseek.js";
import { Error as ToolError } from "@opencode/plugin/promise/tool";

const context = sessionID => ({ sessionID, agent: "build", messageID: "message", id: "call", signal: new AbortController().signal,
    progress: async () => {} });
test("the picker defaults to random without changing native selection until a default is saved", async () => {
    const initial = await fixture();
    assert.equal(initial.ctx.selected, undefined);
    assert.equal((await initial.service.state()).defaultProvider, "random");
    const configured = await fixture({ configured: "tavily" });
    assert.equal(configured.ctx.selected, undefined);
    assert.equal((await configured.service.state()).defaultProvider, "tavily");
    const disabled = await fixture({ configured: false });
    assert.equal(disabled.ctx.selected, undefined);
    assert.equal((await disabled.service.state()).enabled, false);
    await assert.rejects(disabled.service.select({ providerID: "exa", scope: "session", sessionID: "A" }), /搜索已禁用/);
});
test("session choices are isolated, persistent, and do not change the project default", async () => {
    const { ctx, service, storage } = await fixture();
    await service.select({ providerID: "exa", scope: "session", sessionID: "A" });
    assert.equal((await service.state("A")).sessionProvider, "exa");
    assert.equal((await service.state("B")).sessionProvider, undefined);
    assert.equal(ctx.selected, undefined);
    const reloaded = await fixture({ saved: Object.fromEntries(storage) });
    assert.equal((await reloaded.service.state("A")).sessionProvider, "exa");
    assert.equal((await reloaded.service.state()).defaultProvider, "random");
});
test("default saves clear only the active session override and survive reloading", async () => {
    const { service, storage } = await fixture();
    for (const sessionID of ["A", "B"]) await service.select({ providerID: "exa", scope: "session", sessionID });
    await service.select({ providerID: "tavily", scope: "default", sessionID: "A" });
    assert.equal((await service.state("A")).sessionProvider, undefined);
    assert.equal((await service.state("B")).sessionProvider, "exa");
    assert.equal((await (await fixture({ saved: Object.fromEntries(storage) })).service.state()).defaultProvider, "tavily");
});
test("DSS is visible but disabled without a connection and follows current account switching", async () => {
    const { service, providers, switchCredential } = await fixture({ transport: async (_url, request) =>
        Response.json({ results: [{ url: "https://example.invalid", summary: request.headers.Authorization }] }) });
    assert.deepEqual((await service.state()).providers.at(-1), { id: "dss", name: "DSS", available: false });
    await assert.rejects(service.select({ providerID: "dss", scope: "default" }), /connect/);
    switchCredential({ type: "key", key: "first-fixture" });
    assert.ok((await service.state()).providers.some(provider => provider.id === "dss" && provider.available));
    const execute = providers.get("dss").execute;
    assert.equal((await execute({ query: "test" }, { signal: new AbortController().signal }))[0].content, "Bearer first-fixture");
    switchCredential({ type: "key", key: "second-fixture" });
    assert.equal((await execute({ query: "test" }, { signal: new AbortController().signal }))[0].content, "Bearer second-fixture");
    switchCredential(undefined);
    await service.state();
    assert.equal(providers.has("dss"), false);
    await assert.rejects(execute({ query: "test" }, { signal: new AbortController().signal }), /connect/);
});
test("unknown providers and a missing current session are rejected", async () => {
    const { service } = await fixture();
    await assert.rejects(service.select({ providerID: "missing", scope: "default" }), /不可用/);
    await assert.rejects(service.select({ providerID: "exa", scope: "session" }), /先打开/);
});
test("a session in another directory cannot read or change this project's selections", async () => {
    const { service, storage } = await fixture({ sessionLocations: { B: "/fixture/other-project" } });
    await assert.rejects(service.state("B"), /会话位置已变化/);
    for (const scope of ["session", "default"])
        await assert.rejects(service.select({ providerID: "exa", scope, sessionID: "B" }), /会话位置已变化/);
    assert.equal(storage.has("fixture-config"), false);
    assert.equal(storage.has(service.sessionKey("B")), false);
});
test("a native transform can disable search, while an explicit effective configuration overrides it", async () => {
    const disabled = await fixture({ nativeDefault: false });
    assert.equal((await disabled.service.state()).enabled, false);
    await assert.rejects(disabled.service.select({ providerID: "exa", scope: "session", sessionID: "A" }), /搜索已禁用/);
    const configured = await fixture({ nativeDefault: false, configured: "tavily" });
    assert.equal((await configured.service.state()).enabled, true);
    assert.equal((await configured.service.state()).defaultProvider, "tavily");
});
test("defaults changed by later transforms are read after the whole registry replay", async () => {
    const { service, ctx, switchNativeDefault } = await fixture();
    switchNativeDefault("tavily");
    assert.equal((await service.state()).defaultProvider, "tavily");
    switchNativeDefault(false);
    assert.equal((await service.state()).enabled, false);
    const explicit = await service.state(undefined, [{ websearch: { provider: "exa" } }]);
    assert.equal(explicit.defaultProvider, "exa");
    assert.equal(explicit.enabled, true);
    assert.equal(ctx.selected, undefined);
});
test("inherited native disable settings hide the session action and reject a session save", async () => {
    const { service, storage } = await fixture();
    const sources = [{ path: "/fixture/global/opencode.json", websearch: false }];
    assert.equal((await service.state("A", sources)).enabled, false);
    await assert.rejects(service.select({ providerID: "exa", scope: "session", sessionID: "A", sources }), /搜索已禁用/);
    assert.equal(storage.has(service.sessionKey("A")), false);
});
test("session random is rejected and preserves both the session choice and the project default", async () => {
    const { service, ctx, storage } = await fixture({ configured: "tavily" });
    await service.select({ providerID: "exa", scope: "session", sessionID: "A" });
    await assert.rejects(service.select({ providerID: "random", scope: "session", sessionID: "A" }), /random 仅支持/);
    const state = await service.state("A");
    assert.equal(state.sessionProvider, "exa");
    assert.equal(state.defaultProvider, "tavily");
    assert.equal(ctx.selected, undefined);
    assert.equal(storage.get(service.sessionKey("A")), "exa");
});
test("a failed default configuration write restores the current session override", async () => {
    const { service, storage } = await fixture();
    await service.select({ providerID: "exa", scope: "session", sessionID: "A" });
    service.configuration.write = async () => { throw new Error("fixture write failure"); };
    await assert.rejects(service.select({ providerID: "tavily", scope: "default", sessionID: "A" }), /fixture write failure/);
    assert.equal(storage.get(service.sessionKey("A")), "exa");
    assert.equal((await service.state()).defaultProvider, "random");
});
test("sessions without an override execute the unchanged native tool", async () => {
    const { service, calls } = await fixture();
    const input = { query: "native query" }, ctx = context("A"), result = { content: "native", metadata: { unchanged: true } };
    const execute = wrapSearch(service, async (actualInput, actualContext) => {
        assert.equal(actualInput, input); assert.equal(actualContext, ctx); return result;
    });
    assert.equal(await execute(input, ctx), result);
    assert.equal(calls.permission.length, 0);
    assert.equal(calls.query.length, 0);
});
test("session overrides retain the original websearch permission and provider metadata", async () => {
    const { service, calls } = await fixture();
    await service.select({ providerID: "exa", scope: "session", sessionID: "A" });
    const execute = wrapSearch(service, () => assert.fail("Overridden session used native default"));
    const result = await execute({ query: "query" }, context("A"));
    assert.equal(calls.permission[0].action, "websearch");
    assert.deepEqual(calls.permission[0].resources, ["query"]);
    assert.equal(calls.query[0].input.providerID, "exa");
    assert.equal(result.metadata.provider, "exa");
    assert.equal(result.output.provider, "exa");
    assert.match(result.content[0].text, /https:\/\/example.invalid/);
    const denied = new Error("Permission denied fixture");
    service.ctx.permission.assert = async () => { throw denied; };
    await assert.rejects(execute({ query: "query" }, context("A")), error => error === denied);
    assert.equal(calls.query.length, 1);
});

test("session DSS validation gives the model a safe retry hint before requesting search", async () => {
    const { service, calls } = await fixture({ credential: { type: "key", key: "fixture-only" } });
    await service.select({ providerID: "dss", scope: "session", sessionID: "A" });
    const execute = wrapSearch(service, () => assert.fail("DSS override used the native default"));
    for (const query of ["word ".repeat(30), "😀".repeat(129), " "])
        await assert.rejects(execute({ query }, context("A")), error => error.message === DSS_QUERY_ERROR && error._tag === "Tool.Error");
    assert.equal(calls.query.length, 0);
    assert.equal(calls.permission.length, 3);
    const result = await execute({ query: "shorter query" }, context("A"));
    assert.equal(result.metadata.provider, "dss");
    assert.equal(calls.query.length, 1);
    const denied = new Error("Permission denied fixture");
    service.ctx.permission.assert = async () => { throw denied; };
    await assert.rejects(execute({ query: "word ".repeat(30) }, context("A")), error => error === denied);
});

test("native default and random DSS failures expose only the marked local validation hint", async () => {
    const { service } = await fixture();
    const request = { _tag: "WebSearch.Request", providerID: "dss", cause: new QueryValidationError() };
    const wrapped = new ToolError({ message: "Unable to search fixture", error: request });
    for (const original of [request, wrapped]) {
        const execute = wrapSearch(service, async () => { throw original; });
        await assert.rejects(execute({ query: "word ".repeat(30) }, context("A")),
            error => error.message === DSS_QUERY_ERROR && error.metadata.provider === "dss" && error.error === undefined);
    }
    for (const original of [
        new ToolError({ message: "Other fixture error", error: { ...request, providerID: "exa" } }),
        new ToolError({ message: "Other fixture error", error: { ...request, cause: new Error("fixture-only upstream body") } }),
    ]) {
        const execute = wrapSearch(service, async () => { throw original; });
        await assert.rejects(execute({ query: "word ".repeat(30) }, context("A")), error => error === original);
    }
});
