import test from "node:test";
import assert from "node:assert/strict";
import { revisionTrees, loadVersionTrees, statuses } from "../status.js";
import { pluginPath, specifier } from "../catalog.js";

const old = "a".repeat(40), latest = "b".repeat(40), root = "c".repeat(40);
const cfg = (kind, id, ref) => ({ kind, data: { plugins: [specifier(id, ref)] } });

test("only changed plugin directories need updates, including both Goal entrances", () => {
    const configs = [cfg("server", "opencode-providers", old), cfg("server", "opencode-goal", old), cfg("tui", "opencode-goal", latest)];
    const trees = new Map([
        [old, new Map([["plugins/opencode-providers", "old"], ["plugins/opencode-goal", "same"]])],
        [latest, new Map([["plugins/opencode-providers", "new"], ["plugins/opencode-goal", "same"]])],
    ]);
    assert.deepEqual(statuses(configs, latest, "", trees).slice(0, 2).map(p => p.state), ["update", "current"]);
    trees.get(old).set("plugins/opencode-goal", "changed");
    assert.equal(statuses(configs, latest, "", trees)[1].state, "update");
    trees.delete(old);
    assert.equal(statuses(configs, latest, "", trees)[1].state, "unknown");
});

test("unchanged content after unrelated commits or reverts stays current", () => {
    const configs = [cfg("server", "opencode-providers", old)];
    const trees = new Map([old, latest].map(ref => [ref, new Map([["plugins/opencode-providers", "same"]])]));
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
        return new Map([["plugins/opencode-goal", "same"]]);
    }, { readGitTrees: async () => { throw new Error("Git unavailable"); } });
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
    const loaded = await loadVersionTrees(configs, latest, installed, async () => new Map([["plugins/opencode-providers", root]]));
    assert.equal(statuses(configs, latest, installed, loaded)[0].state, "current");
});

test("different Goal refs retain their own cached revisions regardless of list order", async () => {
    const id = "opencode-goal", main = specifier(id, "main"), release = specifier(id, "release");
    const configs = [cfg("server", id, "main"), { kind: "tui", data: { plugins: [{ package: release, options: {} }] } }];
    const rows = [`- ${old.slice(0, 7)} ${release}`, `${id} ${latest.slice(0, 7)} ${main}`];
    for (const installed of [rows.join("\n"), rows.toReversed().join("\n")]) {
        const calls = [];
        const trees = await loadVersionTrees(configs, latest, installed, async ref => {
            calls.push(ref);
            return new Map([[pluginPath(id), ref.startsWith(old.slice(0, 7)) ? "old-tree" : "new-tree"]]);
        });
        assert.deepEqual(new Set(calls), new Set([old.slice(0, 7), latest.slice(0, 7), latest]));
        assert.equal(statuses(configs, latest, installed, trees)[1].state, "update");
        trees.get(old.slice(0, 7)).set(pluginPath(id), "new-tree");
        assert.equal(statuses(configs, latest, installed, trees)[1].state, "current");
    }
});

test("a missing cached source cannot borrow another ref or URL alias's version", async () => {
    const id = "opencode-goal";
    const configs = [cfg("server", id, "main"), cfg("tui", id, "release")];
    const installed = `${id} ${latest} ${specifier(id, "main")}`;
    const trees = await loadVersionTrees(configs, latest, installed, () => assert.fail("unnecessary query"));
    assert.equal(statuses(configs, latest, installed, trees)[1].state, "repair");
    const alias = `github:nichem/opencode-plugins#main::path:plugins/${id}`;
    configs[1].data.plugins = [alias];
    assert.equal(statuses(configs, latest, installed)[1].state, "repair");
    const both = `${installed}\n- ${old} ${alias}`;
    const versions = await loadVersionTrees(configs, latest, both, async ref => new Map([[pluginPath(id), ref]]));
    assert.equal(statuses(configs, latest, both, versions)[1].state, "update");
});

test("invalid, unresolved, truncated and failed API responses cannot imply latest", async () => {
    await assert.rejects(revisionTrees("main", () => assert.fail("invalid request")));
    await assert.rejects(revisionTrees(old, async () => ({ ok: false, status: 403 })));
    await assert.rejects(revisionTrees(old, async () => ({ ok: false, status: 403,
        headers: new Map([["x-ratelimit-remaining", "0"]]) })), /匿名请求额度已用尽/);
    await assert.rejects(revisionTrees(old, async () => ({ ok: true, json: async () => [{ sha: latest }] })));
    let calls = 0;
    await assert.rejects(revisionTrees(old, async () => ({ ok: true, json: async () => ++calls === 1
        ? [{ sha: old, commit: { tree: { sha: root } } }]
        : { truncated: true, tree: [] } })));
});

test("API rate limiting falls back to Git for failed revisions and preserves directory comparisons", async () => {
    const configs = [cfg("server", "opencode-providers", old), cfg("server", "opencode-goal", old), cfg("tui", "opencode-goal", old)];
    const calls = [], messages = [];
    const trees = await loadVersionTrees(configs, latest, "", async ref => {
        if (ref === old) throw new Error("GitHub API 匿名请求额度已用尽 (403)");
        return new Map([["plugins/opencode-providers", "new"], ["plugins/opencode-goal", "same"]]);
    }, { readGitTrees: async refs => {
        calls.push(refs);
        return new Map([[old, new Map([["plugins/opencode-providers", "old"], ["plugins/opencode-goal", "same"]])]]);
    }, report: message => messages.push(message) });
    assert.deepEqual(calls, [[old]]);
    assert.deepEqual(statuses(configs, latest, "", trees).slice(0, 2).map(p => p.state), ["update", "current"]);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /403.*Git/);
});

test("Git fallback handles failure of all API requests without treating unknown versions as latest", async () => {
    const configs = [cfg("server", "opencode-providers", old)];
    const fail = async () => { throw new Error("fetch failed"); };
    const messages = [];
    const trees = await loadVersionTrees(configs, latest, "", fail, {
        readGitTrees: async refs => {
            assert.deepEqual(new Set(refs), new Set([old, latest]));
            return new Map(refs.map(ref => [ref, new Map([["plugins/opencode-providers", root]])]));
        },
    });
    assert.equal(statuses(configs, latest, "", trees)[0].state, "current");
    for (const readGitTrees of [fail, async () => new Map([[latest, trees.get(latest)]])]) {
        messages.length = 0;
        const unknown = await loadVersionTrees(configs, latest, "", fail, { readGitTrees, report: message => messages.push(message) });
        assert.equal(statuses(configs, latest, "", unknown)[0].state, "unknown");
        assert.equal(messages.length, 2);
    }
    await loadVersionTrees(configs, latest, "", async () => new Map(), {
        readGitTrees: () => assert.fail("successful API requests do not need Git"),
    });
});
