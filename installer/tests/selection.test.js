import test from "node:test";
import assert from "node:assert/strict";
import { catalog, specifier, repo } from "../catalog.js";
import { statuses } from "../status.js";
import { createSelection, toggleChecked, toggleUpdate, selectedOperations, selectionLabel, reviewOperations } from "../selection.js";

const latest = "a".repeat(40);
const plugin = catalog[0];
const rowFor = (state, extra = {}, revision = latest) => createSelection([{ ...plugin, state, label: state, ...extra }], revision)[0];

test("installed rows start checked without actions, including update, repair and unknown versions", () => {
    for (const state of ["current", "update", "repair", "unknown", "retired"]) {
        const row = rowFor(state);
        assert.equal(row.checked, true);
        assert.equal(row.update, false);
        assert.deepEqual(selectedOperations([row]), []);
        assert.deepEqual(selectedOperations([toggleChecked(row)]), [{ plugin: row.plugin, action: "remove" }]);
        assert.deepEqual(selectedOperations([toggleChecked(toggleChecked(row))]), []);
    }
    const row = rowFor("absent");
    assert.equal(row.checked, false);
    assert.deepEqual(selectedOperations([toggleChecked(row)]), [{ plugin: row.plugin, action: "install" }]);
    assert.deepEqual(selectedOperations([toggleChecked(toggleChecked(row))]), []);
});

test("u independently toggles updates, repair and migration; unchecking clears the mark", () => {
    for (const [state, extra, action] of [["update", {}, "update"], ["repair", {}, "repair"],
        ["repair", { migrating: true }, "migrate"], ["update", { pathMigration: true }, "migrate"]]) {
        const row = rowFor(state, extra);
        const marked = toggleUpdate(row);
        assert.equal(selectedOperations([marked])[0].action, action);
        assert.deepEqual(selectedOperations([toggleUpdate(marked)]), []);
        const removed = toggleChecked(marked);
        assert.equal(removed.update, false);
        assert.equal(selectedOperations([removed])[0].action, "remove");
        assert.equal(toggleUpdate(removed), removed, "u must not override pending removal");
        assert.deepEqual(selectedOperations([toggleChecked(removed)]), []);
    }
    for (const state of ["current", "absent", "unknown", "retired"]) {
        const row = rowFor(state);
        assert.equal(toggleUpdate(row), row);
    }
});

test("unsupported, native and offline plugins cannot be installed or updated but can be removed and restored", () => {
    for (const extra of [{ unsupported: true, minimumVersion: "2.4.1" }, { replacement: "native", nativeCommand: "/goal" }, {}]) {
        const revision = Object.keys(extra).length ? latest : undefined;
        for (const state of ["absent", "update", "repair", "current"]) {
            const row = createSelection([{ ...plugin, state, ...extra }], revision)[0];
            assert.ok(row.blocked);
            assert.equal(toggleUpdate(row), row);
            if (state === "absent") assert.equal(toggleChecked(row), row);
            else {
                assert.equal(toggleChecked(row).checked, false);
                assert.deepEqual(selectedOperations([toggleChecked(toggleChecked(row))]), []);
            }
        }
    }
});

test("legacy directory migration is an explicit action even when directory contents match", () => {
    const source = `git+${repo}#${latest}::path:${plugin.id}`;
    const configs = [{ kind: "server", data: { plugins: [source] } }];
    const rows = createSelection(statuses(configs, latest, "", new Map(), { hostVersion: "2.4.1" }), latest);
    const row = rows.find(row => row.plugin.id === plugin.id);
    assert.deepEqual(selectedOperations(rows), []);
    assert.equal(selectedOperations([toggleUpdate(row)])[0].action, "migrate");
    assert.match(selectionLabel(toggleUpdate(row)), /待迁移/);
});

test("latest installed SHA remains unchanged unless the user marks a real operation", () => {
    const configs = [{ kind: "server", data: { plugins: [specifier(plugin.id, latest)] } }];
    const rows = createSelection(statuses(configs, latest, "", new Map(), { hostVersion: "2.4.1" }), latest);
    assert.deepEqual(selectedOperations(rows), []);
    const row = rows.find(row => row.plugin.id === plugin.id);
    assert.equal(row.plugin.state, "current");
    assert.equal(toggleUpdate(row), row);
    assert.equal(selectedOperations([toggleChecked(row)])[0].action, "remove");
});

test("empty plans skip confirmation; every nonempty plan is previewed and defaults to no", async () => {
    const messages = [];
    const report = message => messages.push(message);
    assert.equal(await reviewOperations([], { report, confirm: () => assert.fail("no changes to confirm") }), false);
    assert.match(messages.pop(), /没有变更/);
    const operations = ["install", "update", "repair", "migrate", "remove"].map(action => ({
        action, plugin: action === "migrate" ? { ...plugin, id: "opencode-deepseek-skills", migrating: true } : plugin,
    }));
    for (const answer of [false, true]) {
        assert.equal(await reviewOperations(operations, { report, confirm: async options => {
            assert.equal(options.default, false);
            assert.match(options.message, /5 项/);
            const preview = messages.join("\n");
            for (const label of ["安装：", "更新：", "修复：", "迁移：", "卸载：", "websearch → deepseek-skills", "保留账号", "random"])
                assert.ok(preview.includes(label), label);
            return answer;
        } }), answer);
    }
});
