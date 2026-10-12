import { CONNECTION_PAT } from "../src/providers/qoder/auth.js";
import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { QoderLanguageModel } from "../src/providers/qoder/language-model.js";

const model = new QoderLanguageModel("auto");
const frame = (chunk) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(chunk) })}\n\n`;
const text = frame({ choices: [{ delta: { content: "hello" } }] });
const finish = frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
const tool = (args, index = 0) => frame({ choices: [{ delta: { tool_calls: [{ index, id: `call-${index}`, function: { name: "run", arguments: args } }] } }] });
const collect = async (body) => Array.fromAsync(model.responseToStream(new Response(body), []));

test("EOF without a completion marker reports an error", async () => {
    for (const body of ["", text, tool('{}'), tool('{"command":')]) {
        const parts = await collect(body);
        assert.equal(parts.at(-1).finishReason.unified, "error");
        assert.ok(parts.some(p => p.type === "error"));
        assert.ok(!parts.some(p => p.type === "tool-call"));
    }
});

test("finish reason and both DONE envelope formats complete successfully", async () => {
    for (const end of [finish, "data: [DONE]\n\n", 'data: {"body":"[DONE]"}\n\n']) {
        const parts = await collect(text + end);
        assert.equal(parts.at(-1).finishReason.unified, "stop");
        assert.equal(parts.find(p => p.type === "text-delta").delta, "hello");
    }
});

test("partial final line and split UTF-8 chunks are preserved", async () => {
    const bytes = new TextEncoder().encode(frame({ choices: [{ delta: { content: "你好" } }] }) + finish.trimEnd());
    const body = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
    const parts = await collect(body);
    assert.equal(parts.find(p => p.type === "text-delta").delta, "你好");
    assert.equal(parts.at(-1).finishReason.unified, "stop");
});

test("incomplete tools are rejected even with a completion marker", async () => {
    const parts = await collect(tool('{}') + tool('{"command":', 1) + "data: [DONE]\n\n");
    assert.equal(parts.at(-1).finishReason.unified, "error");
    assert.ok(!parts.some(p => p.type === "tool-call"));
});

test("complete tool calls including sparse indices are emitted once", async () => {
    const parts = await collect(tool('{"command":', 1) + frame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"test"}' } }] }, finish_reason: "tool_calls" }] }));
    const calls = parts.filter(p => p.type === "tool-call");
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].input), { command: "test" });
    assert.equal(parts.at(-1).finishReason.unified, "tool-calls");
});

test("DONE completes and cancels a connection that remains open", async () => {
    let cancelled = false;
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text + "data: [DONE]\n\n")); }, cancel() { cancelled = true; } });
    const parts = await collect(body);
    assert.equal(parts.at(-1).finishReason.unified, "stop");
    assert.equal(cancelled, true);
});

test("consumer cancellation cancels a pending upstream read", async () => {
    let upstreamReason, abortReason, cleaned = false;
    const body = new ReadableStream({ cancel(reason) { upstreamReason = reason; } });
    const reader = model.responseToStream(new Response(body), [], r => { abortReason = r; }, () => { cleaned = true; }).getReader();
    await reader.read();
    await reader.cancel("user-stop");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(upstreamReason, "user-stop");
    assert.equal(abortReason, "user-stop");
    assert.equal(cleaned, true);
});

test("HTTP cancellation aborts fetch and releases caller abort listener", async () => {
    const originalFetch = globalThis.fetch;
    const originalDebug = process.env.QODERCN_DEBUG_BODY;
    delete process.env.QODERCN_DEBUG_BODY;
    let requestSignal, cancelled = false;
    globalThis.fetch = async (url, options) => {
        if (String(url).endsWith("/jobToken/exchange")) return Response.json({ token: "mock-job", expires_at: new Date(Date.now() + 3600000).toISOString() });
        if (String(url).endsWith("/userinfo")) return Response.json({ id: "mock-user" });
        requestSignal = options.signal;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    };
    try {
        const controller = new AbortController();
        const result = await new QoderLanguageModel("auto", { [CONNECTION_PAT]: "pt-stream-test" }).doStream({ prompt: [], abortSignal: controller.signal });
        const reader = result.stream.getReader();
        await reader.read();
        await reader.cancel("stop");
        assert.equal(requestSignal.aborted, true);
        assert.equal(cancelled, true);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalDebug === undefined) delete process.env.QODERCN_DEBUG_BODY;
        else process.env.QODERCN_DEBUG_BODY = originalDebug;
    }
});
