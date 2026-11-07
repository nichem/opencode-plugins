import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateCheck } from "../updates.js";
import { specifier } from "../catalog.js";
import { loadVersionTrees } from "../status.js";

const revision = "a".repeat(40);
const configs = [{ kind: "server", path: "fixture.json", original: "{}", data: {} }];
function fixture(options = {}) {
    const calls = { read: 0, latest: 0, list: 0, trees: 0 };
    const check = createUpdateCheck("2.2.6", {
        read: async () => { calls.read++; return configs; },
        latest: async () => { calls.latest++; return revision; },
        list: async () => { calls.list++; return { stdout: "fixture" }; },
        loadTrees: async () => { calls.trees++; return new Map(); },
        ...options,
    });
    return { check, calls };
}

test("version and inventory requests start at launch; entering install shares the pending check", async t => {
    const gate = Promise.withResolvers();
    const { check, calls } = fixture({ latest: () => gate.promise });
    t.after(() => check.close());
    assert.equal(calls.read, 1);
    assert.equal(calls.list, 1);
    assert.equal(check.ready, false);
    let waits = 0;
    const install = check.get(configs, { onWait: () => waits++ });
    gate.resolve(revision);
    const result = await install;
    assert.equal(result.latest, revision);
    assert.equal(result.installed, "fixture");
    assert.equal(calls.trees, 1);
    assert.equal(check.ready, true);
    assert.equal(waits, 1);
    assert.equal(await check.get(configs, { onWait: () => assert.fail("ready data must not wait") }), result);
    assert.equal(calls.list, 1);
});

test("configuration edits, cache expiry and explicit refresh discard old snapshots", async t => {
    let time = 0;
    const { check, calls } = fixture({ now: () => time });
    t.after(() => check.close());
    await check.get(configs);
    const changed = [{ ...configs[0], original: '{"changed":true}', data: { changed: true } }];
    await check.get(changed);
    assert.equal(calls.latest, 2);
    await check.get(changed);
    assert.equal(calls.latest, 2);
    time = 60000;
    await check.get(changed);
    assert.equal(calls.latest, 3);
    check.refresh(changed);
    await check.get(changed);
    assert.equal(calls.latest, 4);
});

test("an edit while startup preparation is pending cannot reuse the old configuration snapshot", async t => {
    const gate = Promise.withResolvers();
    let reads = 0;
    const { check } = fixture({ loadTrees: async () => { if (++reads === 1) await gate.promise; return new Map(); } });
    t.after(() => check.close());
    const changed = [{ ...configs[0], original: '{"other":true}', data: { other: true } }];
    const result = check.get(changed);
    gate.resolve();
    await result;
    assert.equal(reads, 2);
});

test("failed background checks are handled and retried on the next visit", async t => {
    let attempts = 0;
    const { check } = fixture({ latest: async () => { if (++attempts === 1) throw new Error("offline"); return revision; } });
    t.after(() => check.close());
    const failed = await check.get(configs);
    assert.match(failed.error, /GitHub 版本检查失败/);
    assert.equal((await check.get(configs)).latest, revision);
    assert.equal(attempts, 2);
});

test("partial directory failures are not cached as current, and diagnostics wait for the install page", async t => {
    const older = "b".repeat(40);
    const original = JSON.stringify({ plugins: [specifier("opencode-providers", older)] });
    const installed = [{ ...configs[0], original, data: JSON.parse(original) }];
    let attempts = 0;
    const { check } = fixture({ read: async () => installed,
        loadTrees: async (_configs, _latest, _inventory, _reader, options) => {
            attempts++;
            options.report("fixture fallback warning");
            return new Map([[older, undefined], [revision, new Map()]]);
        },
    });
    t.after(() => check.close());
    const result = await check.get(installed);
    assert.equal(result.reusable, false);
    assert.deepEqual(result.messages, ["fixture fallback warning"]);
    await check.get(installed);
    assert.equal(attempts, 2);
});

test("exiting aborts background requests and waits for their cleanup", async () => {
    let cancelled = 0;
    const wait = ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
        cancelled++; reject(signal.reason);
    }, { once: true }));
    const { check } = fixture({ latest: wait, list: wait });
    await check.close();
    assert.equal(cancelled, 2);
    await assert.rejects(check.get(configs), /已关闭/);
});

test("cancelling directory metadata requests does not start a Git fallback", async () => {
    const controller = new AbortController();
    const snapshot = [{ ...configs[0], data: { plugins: [specifier("opencode-providers", "b".repeat(40))] } }];
    const operation = loadVersionTrees(snapshot, revision, "", async (_ref, _request, { signal }) => {
        assert.equal(signal, controller.signal);
        controller.abort();
        signal.throwIfAborted();
    }, { signal: controller.signal, readGitTrees: () => assert.fail("cancelled checks must not fall back") });
    await assert.rejects(operation, { name: "AbortError" });
});
