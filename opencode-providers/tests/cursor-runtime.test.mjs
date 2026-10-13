import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { setImmediate as nextTick } from "node:timers/promises";
import { doStreamImpl, pumpWithRecovery, sessionManager, refreshHeldSessionToolCatalog, encodeMessage, decodeMessage } from "../src/providers/cursor/vendor/protocol.js";

const tool = name => ({ type: "function", name, inputSchema: { type: "object", properties: {} } });
const endTurn = { interaction_update: { turn_ended: {} } };
const readExec = id => ({ exec_server_message: { id, read_args: { path: "/virtual-fixture.txt" } } });

async function fixture(t, names = ["read"]) {
    const queued = [], writes = [];
    let waiter, destroyed = false;
    const stream = {
        isClosed() { return destroyed; },
        write(bytes) { writes.push(decodeMessage("AgentClientMessage", bytes)); return true; },
        destroy() { destroyed = true; waiter?.({ done: true }); waiter = undefined; },
    };
    const session = {
        sessionId: randomUUID(), conversationId: randomUUID(), stream,
        frames: { next: () => queued.length ? Promise.resolve({ done: false, value: queued.shift() })
            : destroyed ? Promise.resolve({ done: true }) : new Promise(resolve => { waiter = resolve; }) },
        pending: new Map(), blobs: new Map(), displayToolCalls: new Map(), editToolCalls: new Map(), nextBridgedExecId: 900000,
        requestContext: {}, usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
        policy: { heartbeatMs: 10000, semanticIdleMs: 120000, hardCapMs: 300000 },
    };
    await refreshHeldSessionToolCatalog(session, { tools: names.map(tool) });
    t.after(() => sessionManager.close(session));
    const push = message => {
        const frame = { flags: 0, payload: encodeMessage("AgentServerMessage", message) };
        if (waiter) { const resolve = waiter; waiter = undefined; resolve({ done: false, value: frame }); }
        else queued.push(frame);
    };
    async function pump() {
        const parts = [];
        await pumpWithRecovery({ initialSession: session, controller: { enqueue: p => parts.push(p), error: e => { throw e; } },
            recover: () => { throw new Error("Unexpected retry"); } });
        return parts;
    }
    return { session, writes, push, pump };
}

test("real protocol restricts named tools and rejects required-tool text-only completion", { timeout: 5000 }, async t => {
    await t.test("specific tool denies another valid tool", async t => {
        const f = await fixture(t, ["read", "shell"]);
        await refreshHeldSessionToolCatalog(f.session, { tools: [tool("read"), tool("shell")], toolChoice: { type: "tool", toolName: "read" } });
        assert.deepEqual([...f.session.permittedToolNames], ["read"]);
        f.push({ exec_server_message: { id: 1, shell_args: { command: "fixture-never-executed" } } });
        f.push(readExec(2));
        const parts = await f.pump();
        assert.deepEqual(parts.filter(p => p.type === "tool-call").map(p => p.toolName), ["read"]);
        assert.ok(f.writes.length > 0);
        assert.equal(parts.at(-1).finishReason.unified, "tool-calls");
    });
    for (const choice of [{ type: "required" }, { type: "tool", toolName: "read" }]) {
        await t.test(`${choice.type} rejects no-tool completion`, async t => {
            const f = await fixture(t);
            await refreshHeldSessionToolCatalog(f.session, { tools: [tool("read")], toolChoice: choice });
            f.push(endTurn);
            await assert.rejects(f.pump(), /toolChoice requires a tool call/);
        });
    }
    await t.test("invalid tool choice fails before execution", async t => {
        const f = await fixture(t);
        await assert.rejects(refreshHeldSessionToolCatalog(f.session, { tools: [tool("read")], toolChoice: { type: "tool", toolName: "missing" } }), /unavailable/);
        await assert.rejects(refreshHeldSessionToolCatalog(f.session, { tools: [], toolChoice: { type: "required" } }), /at least one/);
    });
});

test("cached native questions and todo display events cannot bypass current tool permissions", { timeout: 5000 }, async t => {
    for (const native of ["question", "todowrite"]) for (const allowed of [false, true]) await t.test(`${native}: ${allowed ? "allowed" : "removed"}`, async t => {
        const f = await fixture(t, ["read", native]);
        await refreshHeldSessionToolCatalog(f.session, { tools: allowed ? [tool("read"), tool(native)] : [tool("read")],
            ...(allowed ? { toolChoice: { type: "tool", toolName: native } } : {}) });
        assert.ok(f.session.toolCatalog.some(item => item.name === native));
        assert.equal(f.session.permittedToolNames.has(native), allowed);
        if (native === "question") {
            const args = encodeMessage("AskQuestionInteractionQuery", { args: { questions: [{ id: "q", prompt: "Fixture?" }] }, tool_call_id: "fixture-q" });
            f.push({ interaction_query: { id: 1, ask_question_interaction_query: args } });
        } else {
            const call = { update_todos_tool_call: { args: { todos: [{ id: "fixture-todo", content: "Fixture task", status: 1 }] } } };
            f.push({ interaction_update: { tool_call_started: { call_id: "fixture-todo", tool_call: call } } });
            f.push({ interaction_update: { tool_call_completed: { call_id: "fixture-todo", tool_call: call } } });
        }
        f.push(endTurn);
        const parts = await f.pump();
        assert.deepEqual(parts.filter(p => p.type === "tool-call").map(p => p.toolName), allowed ? [native] : []);
        if (native === "question" && !allowed) assert.ok(f.writes[0].interaction_response.ask_question_interaction_response.result.rejected);
    });
});

async function heldCall(t, { toolChoice, output = { type: "text", value: "Fixture host output" } } = {}) {
    const f = await fixture(t);
    // No terminal turn is emitted for this fixture, so persistence is never used.
    f.session.openCodeSessionId = `fixture-${randomUUID()}`;
    sessionManager.registerPending(1, f.session, "mcp_result", "read");
    const start = (id, signal) => doStreamImpl("fixture-model", {
        getAccessToken() { throw new Error("Test must reuse the held stream, without authentication or network"); },
    }, { abortSignal: signal, headers: { "x-opencode-session-id": f.session.openCodeSessionId }, tools: [tool("read")], toolChoice,
        prompt: [{ role: "tool", content: [{ type: "tool-result", toolCallId: `cursor_${f.session.sessionId}_${id}`, toolName: "read", output }] }] });
    return { ...f, start };
}

test("cancelling continuation preparation closes the held stream before any result is sent", { timeout: 3000 }, async t => {
    for (const supportsImages of [false, true]) await t.test(`supportsImages=${supportsImages}`, async t => {
        const f = await heldCall(t), controller = new AbortController();
        f.session.supportsImages = supportsImages;
        const request = f.start(1, controller.signal);
        controller.abort();
        await assert.rejects(request, /abort|cancel/i);
        assert.equal(f.session.closed, true);
        assert.equal(f.session.stream.isClosed(), true);
        assert.equal(f.session.pending.size, 0);
        assert.equal(f.writes.length, 0);
    });
});

test("cancelling a tool image download closes the held stream without returning results", { timeout: 3000 }, async t => {
    const url = "https://fixture.invalid/tool-result.png";
    const f = await heldCall(t, { output: { type: "content", value: [{ type: "image-url", url }] } });
    f.session.supportsImages = true;
    const controller = new AbortController(), downloading = Promise.withResolvers();
    t.mock.method(globalThis, "fetch", (input, { signal }) => {
        assert.equal(String(input), url);
        signal.throwIfAborted();
        downloading.resolve();
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const request = f.start(1, controller.signal);
    await downloading.promise;
    controller.abort();
    await assert.rejects(request, /abort|cancel/i);
    assert.equal(f.session.closed, true);
    assert.equal(f.session.stream.isClosed(), true);
    assert.equal(f.session.pending.size, 0);
    assert.equal(f.writes.length, 0);
});

test("invalid continuation tool choice closes the held stream before sending results", { timeout: 3000 }, async t => {
    const f = await heldCall(t, { toolChoice: { type: "tool", toolName: "missing" } });
    await assert.rejects(f.start(1), /unavailable/);
    assert.equal(f.session.closed, true);
    assert.equal(f.session.stream.isClosed(), true);
    assert.equal(f.session.pending.size, 0);
    assert.equal(f.writes.length, 0);
});

test("doStream abort and consumer cancel promptly interrupt a silent upstream", { timeout: 3000 }, async t => {
    for (const mode of ["abort", "cancel"]) await t.test(mode, async t => {
        const f = await heldCall(t), signal = new AbortController();
        const { stream } = await f.start(1, signal.signal);
        const reader = stream.getReader();
        assert.equal((await reader.read()).value.type, "stream-start");
        const pending = reader.read();
        const settled = pending.then(value => ({ value }), error => ({ error }));
        await nextTick();
        assert.ok(f.session.pendingFrameRead);
        if (mode === "abort") signal.abort();
        else await reader.cancel();
        assert.equal(f.session.closed, true);
        const result = await settled;
        if (mode === "abort") assert.match(result.error.message, /cancel/i);
        else assert.equal(result.value.done, true);
    });
});

test("late cancellation after a tool handoff cannot close the next call", { timeout: 3000 }, async t => {
    const f = await heldCall(t), old = new AbortController(), current = new AbortController();
    f.push(readExec(2));
    const first = await f.start(1, old.signal);
    const parts = [];
    for await (const part of first.stream) parts.push(part);
    assert.equal(parts.at(-1).finishReason.unified, "tool-calls");
    assert.equal(f.session.closed, false);
    const second = await f.start(2, current.signal);
    const reader = second.stream.getReader();
    await reader.read();
    const pending = reader.read().catch(error => error);
    await nextTick();
    old.abort();
    await first.stream.cancel();
    assert.equal(f.session.closed, false);
    current.abort();
    assert.equal(f.session.closed, true);
    assert.match((await pending).message, /cancel/i);
});

test("cancelling a partial parallel tool step closes the stream before handoff", { timeout: 3000 }, async t => {
    const f = await heldCall(t), controller = new AbortController();
    f.push({ interaction_update: { tool_requests_listed: { call_count: 2 } } });
    f.push(readExec(2));
    const { stream } = await f.start(1, controller.signal);
    const reader = stream.getReader();
    let part;
    do { part = (await reader.read()).value; } while (part.type !== "tool-call");
    assert.equal(f.session.pending.size, 1);
    const waiting = reader.read().catch(error => error);
    await nextTick();
    controller.abort();
    assert.equal(f.session.closed, true);
    assert.equal(f.session.pending.size, 0);
    assert.match((await waiting).message, /cancel/i);
});
