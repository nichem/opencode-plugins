import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter, getEventListeners } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { cursorSandbox, consume } from "./helpers/cursor-sandbox.mjs";

const retryFrame = { flags: 2, payload: new TextEncoder().encode(JSON.stringify({ error: { code: "unavailable" } })) };

test("initial and recovery Run preparation owns cancellation and failure cleanup", { timeout: 15000 }, async t => {
    for (const retry of [false, true]) for (const phase of ["context-cancel", "context-error", "late-open", "write-error"]) {
        await t.test(`${retry ? "retry" : "initial"}: ${phase}`, async t => {
            const ready = Promise.withResolvers(), gate = Promise.withResolvers(), controller = new AbortController();
            const target = retry ? 2 : 1;
            let contexts = 0;
            const h = await cursorSandbox(t, {
                async open(stream, attempt) {
                    if (retry && attempt === 1) stream.push(retryFrame);
                    if (attempt === target && phase === "late-open") { ready.resolve(); await gate.promise; }
                    if (attempt === target && phase === "write-error") stream.write = () => { throw new Error("fixture write failed"); };
                    return stream;
                },
                async context() {
                    if (++contexts === target && phase.startsWith("context")) { ready.resolve(); return gate.promise; }
                    return { context: {}, reused: false };
                },
            });
            const result = consume(h.start({ abortSignal: controller.signal })).then(value => ({ value }), error => ({ error }));
            if (phase !== "write-error") {
                await ready.promise;
                if (phase === "context-error") gate.reject(new Error("fixture context failed"));
                else controller.abort();
            }
            const { error } = await result;
            assert.match(error?.message ?? "", phase === "write-error" ? /initial Run request write failed/ : phase === "context-error" ? /fixture context failed/ : /abort|cancel/i);
            // Cancellation settles before the context/handshake finishes.
            if (phase === "context-cancel") assert.equal(h.streams.at(-1).isClosed(), true);
            gate.resolve({ context: {}, reused: false });
            await tick();
            assert.equal(h.streams.length, target);
            assert.equal(h.streams.at(-1).isClosed(), true);
            assert.equal(h.streams.at(-1).writes.length, 0);
            assert.equal(h.api.sessionManager.sessions.size, 0);
        });
    }
});

test("cancelling authentication stops waiting and never opens a late Run", { timeout: 3000 }, async t => {
    const h = await cursorSandbox(t), ready = Promise.withResolvers(), token = Promise.withResolvers(), controller = new AbortController();
    const pending = h.start({ abortSignal: controller.signal }, { getAccessToken: () => { ready.resolve(); return token.promise; } });
    const outcome = pending.catch(error => error);
    await ready.promise;
    controller.abort();
    assert.match((await outcome).message, /abort|cancel/i);
    token.resolve("fixture-late-token");
    await tick();
    assert.equal(h.streams.length, 0);
});

test("successful initial and recovery Runs hand their stream to the pump", { timeout: 3000 }, async t => {
    for (const retry of [false, true]) await t.test(retry ? "recovery" : "initial", async t => {
        const h = await cursorSandbox(t, { open: (stream, attempt) => {
            stream.push(retry && attempt === 1 ? retryFrame : {
                flags: 0, payload: h.api.encodeMessage("AgentServerMessage", { interaction_update: { turn_ended: {} } }),
            });
            return stream;
        } });
        const parts = await consume(h.start());
        assert.equal(parts.at(-1).type, "finish");
        assert.equal(parts.at(-1).finishReason.unified, "stop");
        assert.equal(h.streams.length, retry ? 2 : 1);
        for (const stream of h.streams) {
            assert.equal(stream.writes.length, 1);
            assert.equal(stream.isClosed(), true);
        }
        assert.equal(h.api.sessionManager.sessions.size, 0);
    });
});

test("fresh-turn cancellation interrupts prior cleanup without cancelling another active call", { timeout: 3000 }, async t => {
    for (const busy of [false, true]) await t.test(busy ? "prior still generating" : "prior tool handoff draining", async t => {
        const ready = Promise.withResolvers(), controller = new AbortController();
        const key = `fixture-${randomUUID()}`, headers = { "x-opencode-session-id": key };
        let draining = false;
        const h = await cursorSandbox(t, { read: () => { if (draining) ready.resolve(); } });
        const first = await h.start({ headers });
        if (!busy) {
            h.streams[0].push({ flags: 0, payload: h.api.encodeMessage("AgentServerMessage", {
                exec_server_message: { id: 1, read_args: { path: "/virtual-fixture.txt" } },
            }) });
            const parts = await consume(Promise.resolve(first));
            assert.equal(parts.at(-1).finishReason.unified, "tool-calls");
            draining = true;
        }
        const outcome = h.start({ headers, abortSignal: controller.signal }).catch(error => error);
        if (busy) await tick();
        else await ready.promise;
        controller.abort();
        assert.equal(h.streams[0].isClosed(), !busy);
        assert.match((await outcome).message, /abort|cancel/i);
        assert.equal(h.streams.length, 1);
        if (busy) await first.stream.cancel();
    });
});

test("real HTTP/2 Run transport observes preparation cancellation and detached handoffs", { timeout: 3000 }, async t => {
    for (const phase of ["handshake", "open", "handoff"]) await t.test(phase, async t => {
        const ready = Promise.withResolvers(), gate = Promise.withResolvers(), controller = new AbortController();
        let requests = 0;
        const wire = new EventEmitter();
        wire.closed = wire.destroyed = false;
        wire.close = () => { wire.closed = true; wire.emit("close"); };
        const sharedSession = { request: () => { requests++; return wire; }, close: () => assert.fail("Sibling Runs must not be closed") };
        const h = await cursorSandbox(t, { h2Session: async () => {
            ready.resolve();
            if (phase === "handshake") await gate.promise;
            return sharedSession;
        } });
        const lifetime = h.api.fixtureLifetime(controller.signal, { close: session => session.stream.destroy() });
        const pending = h.api.fixtureTransport("fixture-token", { baseURL: "https://api2.cursor.sh", signal: lifetime.signal });
        if (phase === "handshake") {
            await ready.promise;
            controller.abort();
            gate.resolve();
            await assert.rejects(pending, /abort|cancel/i);
            assert.equal(requests, 0);
        } else {
            const stream = await pending;
            t.after(() => stream.destroy());
            lifetime.bind({ stream });
            if (phase === "handoff") lifetime.observe({ enqueue() {} }).enqueue({ type: "finish" });
            controller.abort();
            assert.equal(stream.isClosed(), phase === "open");
            stream.destroy();
            assert.equal(getEventListeners(lifetime.signal, "abort").length, 0);
        }
    });
});

test("rewinding all assistant history discards the cached conversation", { timeout: 15000 }, async t => {
    for (const restored of [false, true]) for (const kind of ["text", "reasoning", "tool"]) {
        await t.test(`${restored ? "restored" : "live"}: ${kind}`, async t => {
            const cleared = [], key = `fixture-${randomUUID()}`;
            let seed;
            const h = await cursorSandbox(t, {
                hydrate: id => { if (restored && seed) h.api.fixtureRestore(id, seed.provenance); },
                clear: (...args) => cleared.push(args),
            });
            const part = kind === "tool" ? { type: "tool-call", toolCallId: "fixture-old-call" }
                : { type: `${kind}-delta`, delta: "fixture removed reply" };
            seed = h.api.fixtureSeed(key, [part], restored);
            const { stream } = await h.start({ headers: { "x-opencode-session-id": key } });
            const run = h.streams.at(-1).writes.find(part => part.run_request).run_request;
            assert.notEqual(run.conversation_id, seed.conversationId);
            assert.equal(Buffer.from(run.conversation_state).includes(Buffer.from("fixture deleted checkpoint")), false);
            assert.deepEqual(cleared, [[key, seed.conversationId]]);
            await stream.cancel();
        });
    }
});

test("unchanged history retains its checkpoint and a new empty conversation is not reset", { timeout: 5000 }, async t => {
    for (const warm of [false, true]) await t.test(warm ? "matching assistant history" : "no prior output", async t => {
        const cleared = [], key = `fixture-${randomUUID()}`;
        const h = await cursorSandbox(t, { clear: (...args) => cleared.push(args) });
        const seed = h.api.fixtureSeed(key, warm ? [{ type: "text-delta", delta: "fixture reply" }] : []);
        const prompt = [{ role: "user", content: [{ type: "text", text: "fixture question" }] }];
        if (warm) prompt.push({ role: "assistant", content: [{ type: "text", text: "fixture reply" }] },
            { role: "user", content: [{ type: "text", text: "fixture next question" }] });
        const { stream } = await h.start({ prompt, headers: { "x-opencode-session-id": key } });
        const run = h.streams.at(-1).writes.find(part => part.run_request).run_request;
        assert.equal(run.conversation_id, seed.conversationId);
        assert.deepEqual(Buffer.from(run.conversation_state), seed.checkpoint);
        assert.deepEqual(cleared, []);
        await stream.cancel();
    });
});
