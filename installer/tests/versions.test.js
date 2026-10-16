import test from "node:test";
import assert from "node:assert/strict";
import { revisionTrees, loadVersionTrees, statuses } from "../status.js";
import { specifier } from "../catalog.js";

const old = "a".repeat(40), latest = "b".repeat(40), root = "c".repeat(40);
const cfg = (kind, id, ref) => ({ kind, data: { plugins: [specifier(id, ref)] } });

test("only changed plugin directories need updates, including both Goal entrances", () => {
    const configs = [cfg("server", "opencode-providers", old), cfg("server", "opencode-goal", old), cfg("tui", "opencode-goal", latest)];
    const trees = new Map([
        [old, new Map([["opencode-providers", "old"], ["opencode-goal", "same"]])],
        [latest, new Map([["opencode-providers", "new"], ["opencode-goal", "same"]])],
    ]);
    assert.deepEqual(statuses(configs, latest, "", trees).slice(0, 2).map(p => p.state), ["update", "current"]);
    trees.get(old).set("opencode-goal", "changed");
    assert.equal(statuses(configs, latest, "", trees)[1].state, "update");
    trees.delete(old);
    assert.equal(statuses(configs, latest, "", trees)[1].state, "unknown");
});

test("unchanged content after unrelated commits or reverts stays current", () => {
    const configs = [cfg("server", "opencode-providers", old)];
    const trees = new Map([old, latest].map(ref => [ref, new Map([["opencode-providers", "same"]])]));
    assert.equal(statuses(configs, latest, "", trees)[0].state, "current");
    trees.get(latest).clear();
    assert.equal(statuses(configs, latest, "", trees)[0].state, "unknown");
    assert.equal(statuses([cfg("server", "opencode-providers", latest)], latest)[0].state, "current");
});

test("tree queries are deduplicated and failures remain unknown", async () => {
    const configs = [cfg("server", "opencode-goal", old), cfg("tui", "opencode-goal", old), cfg("server", "opencode-providers", latest)];
    const calls = [];
    const trees = await loadVersionTrees(configs, latest, "", async ref => {
        calls.push(ref);
        if (ref === old) throw new Error("rate limited");
        return new Map([["opencode-goal", "same"]]);
    });
    assert.deepEqual(calls.sort(), [old, latest].sort());
    assert.equal(statuses(configs, latest, "", trees)[1].state, "unknown");
    assert.equal(statuses(configs, latest, "", trees)[0].state, "current");
    await loadVersionTrees([cfg("server", "opencode-providers", latest)], latest, "", () => assert.fail("unnecessary query"));
});

test("short cached revisions resolve through metadata and nonrecursive root trees only", async () => {
    const urls = [];
    const request = async url => {
        urls.push(url);
        return { ok: true, json: async () => urls.length === 1
            ? [{ sha: old, commit: { tree: { sha: root } } }]
            : { tree: [{ path: "opencode-agents", type: "tree", sha: latest }, { path: "README.md", type: "blob", sha: root }] } };
    };
    const trees = await revisionTrees(old.slice(0, 7), request);
    assert.deepEqual([...trees], [["opencode-agents", latest]]);
    assert.ok(urls[0].endsWith(`commits?sha=${old.slice(0, 7)}&per_page=1`));
    assert.ok(urls[1].endsWith(`git/trees/${root}`));
    const configs = [cfg("server", "opencode-providers", "main")];
    const installed = `opencode-providers ${old.slice(0, 7)} ${specifier("opencode-providers", "main")}`;
    const loaded = await loadVersionTrees(configs, latest, installed, async () => new Map([["opencode-providers", root]]));
    assert.equal(statuses(configs, latest, installed, loaded)[0].state, "current");
});

test("invalid, unresolved, truncated and failed API responses cannot imply latest", async () => {
    await assert.rejects(revisionTrees("main", () => assert.fail("invalid request")));
    await assert.rejects(revisionTrees(old, async () => ({ ok: false, status: 403 })));
    await assert.rejects(revisionTrees(old, async () => ({ ok: true, json: async () => [{ sha: latest }] })));
    let calls = 0;
    await assert.rejects(revisionTrees(old, async () => ({ ok: true, json: async () => ++calls === 1
        ? [{ sha: old, commit: { tree: { sha: root } } }]
        : { truncated: true, tree: [] } })));
});
