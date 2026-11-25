import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "jsonc-parser";
import { catalog, specifier, identify, repo } from "../catalog.js";
import { statuses, loadVersionTrees } from "../status.js";
import { createSelection, toggleChecked, toggleUpdate, selectedOperations, selectionLabel } from "../selection.js";
import { planChanges } from "../config.js";
import { applySelection } from "../install.js";

const id = "opencode-deepseek-skills", old = "opencode-websearch", sha = "a".repeat(40);
const selected = catalog.find(p => p.id === id);
const cfg = (kind, plugins, extra = {}) => {
    const data = { plugins, ...extra };
    return { kind, path: `${kind}.jsonc`, original: `{// fixture comment\n${JSON.stringify(data).slice(1)}`, data };
};

test("installer exposes a single skills entry for fresh, legacy, mixed and current installations", () => {
    for (const entries of [[], [specifier(old, sha)], [specifier(id, sha)], [specifier(old, sha), specifier(id, sha)]]) {
        const configs = [cfg("server", entries), cfg("tui", entries)];
        const items = statuses(configs, sha, "", new Map(), { hostVersion: "2.4.1" });
        const choices = createSelection(items, sha);
        assert.equal(choices.filter(p => p.plugin.id === id).length, 1);
        assert.equal(choices.some(p => p.plugin.id === old), false);
        assert.deepEqual(selectedOperations(choices), [], "opening the list never migrates or installs anything");
        const item = choices.find(p => p.plugin.id === id);
        assert.equal(item.checked, Boolean(entries.length));
        if (entries.includes(specifier(old, sha))) {
            assert.match(selectionLabel(item), /websearch → deepseek-skills/);
            assert.equal(selectedOperations([toggleUpdate(item)])[0].action, "migrate");
        } else if (entries.length) assert.equal(toggleUpdate(item), item);
        if (entries.length) assert.equal(selectedOperations([toggleChecked(item)])[0].action, "remove");
    }
});

test("migration handles old roots and both entrances in place, resets dss only, and retains comments/options", () => {
    const legacy = `git+${repo}#main::path:${old}`;
    const configs = [cfg("server", ["first", { package: legacy, options: { keep: true } }, "last"], { websearch: { provider: "dss", keep: true } }),
        cfg("tui", [legacy, "foreign"]), cfg("server", [], { websearch: { provider: "tavily" } })];
    const changes = planChanges(configs, [selected], "install", sha);
    assert.equal(changes.length, 2);
    assert.match(changes[0].next, /fixture comment/);
    const data = parse(changes[0].next);
    assert.deepEqual(data.plugins, ["first", { package: specifier(id, sha), options: { keep: true } }, "last"]);
    assert.deepEqual(data.websearch, { provider: "random", keep: true });
    assert.deepEqual(parse(changes[1].next).plugins, [specifier(id, sha), "foreign"]);
});

test("mixed configurations collapse and uninstall together without deleting unrelated state", () => {
    const configs = [cfg("server", [specifier(old, sha), specifier(id, sha), "foreign"], { account: "fixture" }),
        cfg("tui", [specifier(id, sha), specifier(old, sha)])];
    for (const action of ["install", "remove"]) {
        const changes = planChanges(configs, [selected], action, sha);
        assert.equal(changes.length, 2);
        for (const change of changes) {
            const own = parse(change.next).plugins.filter(e => identify(e));
            assert.equal(own.length, action === "install" ? 1 : 0);
        }
        assert.equal(parse(changes[0].next).account, "fixture");
    }
});

test("preparation failure never uninstalls websearch or writes config", async () => {
    const configs = [cfg("server", [specifier(old, sha)]), cfg("tui", [specifier(old, sha)])];
    await assert.rejects(applySelection(configs, [selected], "install", sha, "/unused", {
        prepare: async list => { assert.equal(list[0].id, id); throw new Error("fixture download failed"); },
        write: () => assert.fail("configuration must remain unchanged"),
    }), /download failed/);
});

test("legacy revisions need no tree queries and unsupported hosts retain an uninstall entry", async () => {
    const configs = [cfg("server", [specifier(old, "b".repeat(40))])];
    const refs = [];
    await loadVersionTrees(configs, sha, "", async ref => { refs.push(ref); return new Map(); });
    assert.deepEqual(refs, []);
    for (const version of ["2.2.1", "2.4.0", "2.4.1-rc.1", undefined]) {
        const items = statuses(configs, sha, "", new Map(), { hostVersion: version });
        const row = createSelection(items, sha).find(p => p.plugin.id === id);
        assert.match(row.blocked, /2.4.1/);
        assert.equal(toggleUpdate(row), row);
        assert.equal(selectedOperations([toggleChecked(row)])[0].action, "remove");
    }
});
