import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parse } from "jsonc-parser";
import { catalog, identify, pluginPath, repo, specifier } from "../catalog.js";
import { planChanges, readConfigs, writeChanges } from "../config.js";
import { nativeReplacement, pluginChoices } from "../policy.js";
import { loadVersionTrees, statuses } from "../status.js";

const goal = catalog.find(plugin => plugin.id === "opencode-goal");
const old = "a".repeat(40), latest = "b".repeat(40), other = "c".repeat(40);
const legacy = `git+${repo}#${old}::path:opencode-goal`;
const configured = (kind, plugins) => ({ kind, path: kind === "server" ? "opencode.jsonc" : "cli.json",
    original: JSON.stringify({ plugins }), data: { plugins } });
const goalState = (configs, hostVersion, revision = latest, trees = new Map()) =>
    statuses(configs, revision, "", trees, { hostVersion }).find(plugin => plugin.id === goal.id);

test("native Goal retirement uses numeric release versions, including the stable threshold and build metadata", () => {
    for (const version of ["2.2.1", "v2.2.1", "opencode v2.2.1", "opencode 2.2.1", "2.2.1+build.1", "2.2.2", "2.3.0-rc.1", "2.10.0"])
        assert.match(nativeReplacement(goal, version), /2\.2\.1.*\/goal/, version);
    for (const version of ["2.0.27", "2.1.99", "2.2.0", "2.2.1-rc.1", "v2.2.1-beta.2+build.1", undefined, "unknown", "2.2", "2.x", "2.2.1junk"])
        assert.equal(nativeReplacement(goal, version), undefined, version);
    for (const plugin of catalog.filter(plugin => plugin.id !== goal.id))
        assert.equal(nativeReplacement(plugin, "opencode v2.2.1"), undefined);
});

test("a fresh 2.2.1 install shows native Goal as disabled and never offers it for uninstall", () => {
    const items = statuses([], latest, "", new Map(), { hostVersion: "opencode v2.2.1" });
    const choices = pluginChoices(items, "install"), choice = choices.find(item => item.value.id === goal.id);
    assert.equal(choice.value.state, "absent");
    assert.match(choice.name, /已原生内置/);
    assert.match(choice.disabled, /原生 \/goal/);
    assert.ok(choices.every(item => !item.checked));
    assert.deepEqual(pluginChoices(items, "remove"), []);
    for (const item of choices.filter(item => item.value.id !== goal.id)) assert.equal(item.disabled, false);
});

test("installed and partially configured retired Goal remains removable even without a known remote version", () => {
    for (const configs of [
        [configured("server", [legacy])],
        [configured("tui", [specifier(goal.id, old)])],
        [configured("server", [legacy]), configured("tui", [specifier(goal.id, old)])],
    ]) {
        const before = structuredClone(configs);
        const items = statuses(configs, undefined, "", new Map(), { hostVersion: "2.2.1" });
        const installed = items.find(plugin => plugin.id === goal.id);
        assert.equal(installed.state, "retired");
        assert.match(installed.label, /卸载旧插件/);
        const remove = pluginChoices(items, "remove");
        assert.equal(remove.length, 1);
        assert.equal(remove[0].value.id, goal.id);
        assert.equal(remove[0].disabled, false);
        assert.match(remove[0].name, /可卸载旧插件/);
        assert.ok(pluginChoices(items, "install").find(item => item.value.id === goal.id).disabled);
        assert.deepEqual(configs, before, "detecting retirement does not automatically edit configuration");
    }
});

test("old OpenCode versions still offer Goal installation, updates and repair of both entries", () => {
    const trees = new Map([[old, new Map([[pluginPath(goal.id), "old"]])], [latest, new Map([[pluginPath(goal.id), "new"]])]]);
    for (const hostVersion of ["2.0.27", "opencode v2.2.0", "2.2.1-rc.1"]) {
        const items = statuses([], latest, "", new Map(), { hostVersion });
        const choice = pluginChoices(items, "install").find(item => item.value.id === goal.id);
        assert.equal(choice.disabled, false);
        const empty = [configured("server", []), configured("tui", [])];
        const installed = planChanges(empty, [choice.value], "install", latest);
        assert.deepEqual(installed.map(config => config.kind), ["server", "tui"]);
        for (const change of installed) assert.equal(identify(parse(change.next).plugins[0]).id, goal.id);
        const configs = [configured("server", [specifier(goal.id, old)]), configured("tui", [specifier(goal.id, old)])];
        assert.equal(goalState(configs, hostVersion, latest, trees).state, "update");
        assert.equal(goalState(configs.slice(0, 1), hostVersion).state, "repair");
    }
});

test("retired Goal does not trigger old commit queries or affect another plugin's update status", async () => {
    const configs = [configured("server", [legacy, specifier("opencode-providers", other)]), configured("tui", [specifier(goal.id, old)])];
    const calls = [];
    const trees = await loadVersionTrees(configs, latest, "", async ref => {
        calls.push(ref);
        assert.notEqual(ref, old);
        return new Map([[pluginPath("opencode-providers"), ref === latest ? "new" : "old"]]);
    }, { hostVersion: "opencode v2.2.1", readGitTrees: () => assert.fail("no fallback needed") });
    assert.deepEqual(new Set(calls), new Set([other, latest]));
    const items = statuses(configs, latest, "", trees, { hostVersion: "2.2.1" });
    assert.equal(items.find(plugin => plugin.id === goal.id).state, "retired");
    assert.equal(items.find(plugin => plugin.id === "opencode-providers").state, "update");
    await loadVersionTrees(configs.filter(config => config.kind === "tui"), latest, "", () => assert.fail("only retired Goal is configured"), { hostVersion: "2.2.1" });
});

test("Git fallback excludes retired Goal refs while older hosts still check them", async () => {
    const configs = [configured("server", [legacy]), configured("tui", [specifier(goal.id, old)])];
    const calls = [];
    await loadVersionTrees(configs, latest, "", async ref => { calls.push(ref); return new Map(); }, { hostVersion: "2.2.1" });
    assert.deepEqual(calls, []);
    const fallback = [];
    await loadVersionTrees(configs, latest, "", async () => { throw new Error("Fixture API failure"); }, {
        hostVersion: "2.2.0", readGitTrees: async refs => {
            fallback.push(...refs);
            return new Map(refs.map(ref => [ref, new Map([[ref === old ? goal.id : pluginPath(goal.id), "same"]])]));
        },
    });
    assert.deepEqual(new Set(fallback), new Set([old, latest]));
});

test("retired Goal uninstall removes all old/new entries with backups, retaining foreign options and stored goals", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-goal-retire-"));
    try {
        const server = join(root, "opencode.jsonc"), tui = join(root, "cli.json"), state = join(root, "goal-state.json");
        const serverText = `{// keep comment\n"plugins":["foreign",{"package":"${legacy}","options":{"fixture":true}},"${specifier(goal.id, latest)}"],"keep":true}`;
        await writeFile(server, serverText);
        await writeFile(tui, JSON.stringify({ plugins: [legacy, specifier(goal.id, latest), { package: "foreign-ui", options: { keep: true } }], theme: "fixture" }));
        await writeFile(state, '{"objective":"Artificial unfinished goal","status":"paused"}');
        const paths = { server: [server], tui: [tui] }, configs = await readConfigs(paths);
        const choices = pluginChoices(statuses(configs, undefined, "", new Map(), { hostVersion: "2.2.1" }), "remove");
        assert.equal(choices.length, 1);
        assert.equal(choices[0].disabled, false);
        const changes = planChanges(configs, [choices[0].value], "remove");
        assert.equal(changes.length, 2);
        const backup = await writeChanges(changes, join(root, "backups"));
        assert.equal(await readFile(join(backup, "0.json.bak"), "utf8"), serverText);
        assert.match(await readFile(server, "utf8"), /keep comment/);
        assert.deepEqual(parse(await readFile(server, "utf8")), { plugins: ["foreign"], keep: true });
        assert.deepEqual(parse(await readFile(tui, "utf8")), { plugins: [{ package: "foreign-ui", options: { keep: true } }], theme: "fixture" });
        assert.equal(await readFile(state, "utf8"), '{"objective":"Artificial unfinished goal","status":"paused"}');
        assert.equal(goalState(await readConfigs(paths), "2.2.1").state, "absent");
    } finally {
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true, force: true });
    }
});
