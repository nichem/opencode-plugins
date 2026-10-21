import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration, liveDuration } from "../src/duration.js";

const reasoning = (created, completed) => ({ type: "reasoning", text: "Artificial thought", time: { created, completed } });
const assistant = (content, extra = {}) => ({ id: "msg_fixture", type: "assistant", content, time: { created: 1000 }, ...extra });

test("duration updates at second boundaries, includes minutes/hours and clamps clock skew", () => {
    assert.equal(formatDuration(999), "0s");
    assert.equal(formatDuration(1000), "1s");
    assert.equal(formatDuration(61000), "1m 1s");
    assert.equal(formatDuration(3661000), "1h 1m 1s");
    assert.equal(formatDuration(-1), "0s");
});

test("the part creation time drives a live clock and reopening does not reset it", () => {
    const messages = [assistant([reasoning(5000)])];
    assert.equal(liveDuration(messages, "running", 7000), 2000);
    assert.equal(liveDuration(messages, "running", 8000), 3000);
    assert.equal(liveDuration(messages, "running", 90000), 85000);
});

test("adjacent reasoning steps sum their durations while tool time is excluded", () => {
    const messages = [assistant([reasoning(1000, 2000), { type: "tool", id: "fixture", name: "read" },
        reasoning(5000, 6000), reasoning(7000)])];
    assert.equal(liveDuration(messages, "running", 9000), 3000);
});

test("a grouped reasoning run can cross assistant message boundaries", () => {
    const previous = assistant([reasoning(1000, 2000)], { time: { created: 1000, completed: 2000 }, finish: "unknown" });
    assert.equal(liveDuration([previous, assistant([reasoning(4000)])], "running", 6000), 3000);
    previous.finish = "stop";
    assert.equal(liveDuration([previous, assistant([reasoning(4000)])], "running", 6000), 2000);
});

test("an individual thought counts its own elapsed time instead of earlier grouped steps", () => {
    const messages = [assistant([reasoning(1000, 4000), reasoning(5000)])];
    assert.equal(liveDuration(messages, "running", 7000), 5000);
    assert.equal(liveDuration(messages, "running", 7000, "part"), 2000);
    messages[0].content[1].time.completed = 7000;
    assert.equal(liveDuration(messages, "running", 9000, "part"), undefined);
});

test("hidden synthetic messages do not split adjacent visible thoughts", () => {
    const previous = assistant([reasoning(1000, 4000)], { time: { created: 1000, completed: 4000 }, finish: "unknown" });
    for (const description of [undefined, "", " \t"]) {
        const hidden = { id: "msg_hidden", type: "synthetic", text: "Artificial hidden context", description, time: { created: 4500 } };
        const messages = [previous, hidden, assistant([reasoning(5000)])];
        assert.equal(liveDuration(messages, "running", 7000), 5000);
        assert.equal(liveDuration(messages, "running", 7000, "part"), 2000);
    }
});

test("visible messages and turn boundaries still split reasoning groups around hidden context", () => {
    const previous = assistant([reasoning(1000, 4000)], { time: { created: 1000, completed: 4000 }, finish: "unknown" });
    const hidden = { type: "synthetic", text: "Artificial hidden context", description: "", time: { created: 4500 } };
    for (const barrier of [
        { type: "synthetic", text: "Artificial context", description: "Visible fixture", time: { created: 4500 } },
        { type: "user", text: "Artificial question", time: { created: 4500 } },
        { type: "idle", time: { created: 4500 } },
    ]) assert.equal(liveDuration([previous, hidden, barrier, hidden, assistant([reasoning(5000)])], "running", 7000), 2000);
    previous.finish = "stop";
    assert.equal(liveDuration([previous, hidden, assistant([reasoning(5000)])], "running", 7000), 2000);
});

test("completed, idle, interrupted, retrying and answer-streaming states have no live timer", () => {
    assert.equal(liveDuration([assistant([reasoning(1000, 2000)])], "running", 9000), undefined);
    assert.equal(liveDuration([assistant([reasoning(1000)], { time: { created: 1000, completed: 2000 } })], "running", 9000), undefined);
    assert.equal(liveDuration([assistant([reasoning(1000)])], "idle", 9000), undefined);
    assert.equal(liveDuration([assistant([reasoning(1000)], { error: { message: "Fixture" } })], "running", 9000), undefined);
    assert.equal(liveDuration([assistant([reasoning(1000)], { retry: {} })], "running", 9000), undefined);
    assert.equal(liveDuration([assistant([reasoning(1000), { type: "text", text: "Answer" }])], "running", 9000), undefined);
    assert.equal(liveDuration([assistant([reasoning(1000)]), assistant([{ type: "tool", name: "read" }])], "running", 9000), undefined);
});

test("missing part timing falls back to message creation; empty and redacted blocks stay hidden", () => {
    assert.equal(liveDuration([assistant([{ type: "reasoning", text: "Fixture" }])], "running", 3000), 2000);
    assert.equal(liveDuration([assistant([{ type: "reasoning", text: "[REDACTED]" }])], "running", 3000), undefined);
    assert.equal(liveDuration([], "running", 3000), undefined);
    assert.equal(liveDuration([assistant([reasoning(9000)])], "running", 3000), 0);
});
