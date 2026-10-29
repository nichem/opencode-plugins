import test from "node:test";
import assert from "node:assert/strict";
import { dssCredential, parseResults, searchDeepSeek, SEARCH_URL } from "../src/deepseek.js";

const signal = () => new AbortController().signal;
test("DSS sends one request to the official API and maps summaries and millisecond publication times", async () => {
    const result = await searchDeepSeek("DeepSeek site:deepseek.com", "fixture-secret", signal(), async (url, options) => {
        assert.equal(url, SEARCH_URL);
        assert.equal(options.method, "POST");
        assert.equal(options.headers.Authorization, "Bearer fixture-secret");
        assert.equal(options.redirect, "error");
        assert.deepEqual(JSON.parse(options.body), { query: "DeepSeek site:deepseek.com", count: 10, need_content: false });
        return Response.json({ results: [{ url: "https://example.invalid", title: "Test", summary: "Long summary", snippet: "Short",
            content: "", date: "2026-10-16T00:00:00Z" }] });
    });
    assert.deepEqual(result, [{ url: "https://example.invalid", title: "Test", content: "Long summary", time: { published: Date.parse("2026-10-16T00:00:00Z") } }]);
});
test("DSS keeps empty results, falls back to snippets, and does not invent publication times", () => {
    assert.deepEqual(parseResults({ results: [] }), []);
    assert.deepEqual(parseResults({ results: [{ url: "https://example.invalid", summary: "", snippet: "Short", date: "invalid" }] }),
        [{ url: "https://example.invalid", content: "Short", time: {} }]);
    assert.throws(() => parseResults({ error: "fixture" }), /无效的搜索结果/);
    assert.throws(() => parseResults({ results: [{ url: "javascript:fixture" }] }), /无效的搜索链接/);
});
test("DSS validates Unicode length without truncating search syntax", async () => {
    const transport = async () => Response.json({ results: [] });
    await searchDeepSeek("😀".repeat(128), "fixture", signal(), transport);
    for (const query of ["", "   ", "😀".repeat(129)])
        await assert.rejects(searchDeepSeek(query, "fixture", signal(), () => assert.fail("Invalid query reached network")), /128/);
});
test("upstream error bodies and transport exceptions cannot leak connection credentials", async () => {
    for (const status of [401, 402, 429, 500]) {
        await assert.rejects(searchDeepSeek("test", "fixture-secret", signal(), async () => new Response("fixture-secret", { status })), error => {
            assert.equal(error.status, status);
            assert.ok(!error.message.includes("fixture-secret"));
            return true;
        });
    }
    await assert.rejects(searchDeepSeek("test", "fixture-secret", signal(), async () => { throw new Error("fixture-secret"); }), /网络异常/);
    await assert.rejects(searchDeepSeek("test", "fixture-secret", signal(), async () => new Response("fixture-secret")), /无效的 JSON/);
});
test("cancellation prevents a request and is propagated to the transport", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(searchDeepSeek("test", "fixture", controller.signal, () => assert.fail("Cancelled request sent")));
    const next = new AbortController();
    const request = searchDeepSeek("test", "fixture", next.signal, async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    next.abort();
    await assert.rejects(request, error => error === next.signal.reason);
});
test("only an active OpenCode key connection is used", async () => {
    for (const value of [undefined, { type: "oauth", access: "fixture" }, { type: "key", key: " " }]) {
        const integration = { connection: { active: async () => ({ type: "credential" }), resolve: async () => value } };
        assert.equal(await dssCredential(integration), undefined);
    }
    assert.equal(await dssCredential({ connection: { active: async () => ({ type: "external" }), resolve: () => assert.fail() } }), undefined);
});

test("DSS resolves only its own active connection without falling back to the DeepSeek model credential", async () => {
    const read = [];
    const credentials = new Map([["deepseek", { type: "key", key: "fixture-model-key" }]]);
    const integration = { connection: {
        active: async id => { read.push(id); return credentials.has(id) ? { type: "credential", id } : undefined; },
        resolve: async connection => credentials.get(connection.id),
    } };
    assert.equal(await dssCredential(integration), undefined);
    credentials.set("dss", { type: "key", key: "fixture-search-key" });
    assert.equal(await dssCredential(integration), "fixture-search-key");
    credentials.set("deepseek", { type: "key", key: "another-fixture-model-key" });
    assert.equal(await dssCredential(integration), "fixture-search-key");
    credentials.delete("dss");
    assert.equal(await dssCredential(integration), undefined);
    assert.deepEqual(read, ["dss", "dss", "dss", "dss"]);
});
