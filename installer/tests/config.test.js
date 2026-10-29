import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { parse } from "jsonc-parser";
import { catalog, identify, specifier } from "../catalog.js";
import { configPaths, planChanges, readConfigs, writeChanges } from "../config.js";
import { statuses } from "../status.js";
const revision = "a".repeat(40), older = "b".repeat(40);
const configs = () => [
    { kind: "server", path: "opencode.json", original: "{}", data: {} },
    { kind: "server", path: "opencode.jsonc", original: null, data: {} },
    { kind: "tui", path: "cli.json", original: "{}", data: {} },
];

test("server and TUI share config directory overrides; an explicit file only affects server configs", () => {
    assert.equal(configPaths({}).tui[0], join(homedir(), ".config", "opencode", "cli.json"));
    const xdg = join(tmpdir(), "config-fixture"), custom = join(tmpdir(), "custom-fixture");
    assert.equal(configPaths({ XDG_CONFIG_HOME: xdg }).tui[0], join(xdg, "opencode", "cli.json"));
    const explicit = join(tmpdir(), "explicit-fixture.json");
    assert.deepEqual(configPaths({ XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: custom, OPENCODE_CONFIG: explicit }), {
        server: [join(custom, "opencode.json"), join(custom, "opencode.jsonc"), resolve(explicit)],
        tui: [join(custom, "cli.json")],
    });
});

test("install and uninstall use the custom TUI config and preserve the default directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-installer-custom-"));
    try {
        const xdg = join(root, "xdg"), custom = join(root, "custom");
        const defaultTui = join(xdg, "opencode", "cli.json");
        const original = '{"plugins":["foreign-plugin"],"theme":"fixture"}';
        await mkdir(join(xdg, "opencode"), { recursive: true });
        await mkdir(custom);
        await writeFile(defaultTui, original);
        await writeFile(join(custom, "cli.json"), original);
        const paths = configPaths({ XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: custom });
        const selected = [catalog[1], catalog[2]];
        const initial = await readConfigs(paths);
        await writeChanges(planChanges(initial, selected, "install", revision), join(root, "backups"));
        const installed = await readConfigs(paths);
        assert.equal(statuses(installed, revision)[1].state, "current");
        assert.deepEqual(installed.find(c => c.kind === "tui").data.plugins, [
            "foreign-plugin", specifier("opencode-goal", revision), specifier("opencode-message-delete", revision),
        ]);
        await writeChanges(planChanges(installed, selected, "remove"), join(root, "backups"));
        const removed = await readConfigs(paths);
        assert.deepEqual(removed.find(c => c.kind === "tui").data, JSON.parse(original));
        assert.equal(statuses(removed, revision)[1].state, "absent");
        assert.equal(await readFile(defaultTui, "utf8"), original);
    } finally {
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true, force: true });
    }
});

test("Goal installation adds both entrances and does not create duplicate server configs", () => {
    const changes = planChanges(configs(), [catalog[1]], "install", revision);
    assert.deepEqual(changes.map(c => c.path), ["opencode.json", "cli.json"]);
    for (const c of changes) assert.deepEqual(parse(c.next).plugins, [specifier("opencode-goal", revision)]);
});

test("updating preserves JSONC comments, credentials, plugin options and foreign plugins", () => {
    const original = '{\n // preserve this comment\n "secret": "fixture-only", "plugins": [{"package":"'+specifier("opencode-providers", older)+'","options":{"providers":{"qoder":{"enabled":false}}}},"foreign-package"],\n}';
    const cfg = { kind: "server", path: "opencode.jsonc", original, data: parse(original) };
    const next = planChanges([cfg], [catalog[0]], "install", revision)[0].next;
    assert.match(next, /preserve this comment/);
    const data = parse(next);
    assert.equal(data.secret, "fixture-only");
    assert.ok(data.plugins.includes("foreign-package"));
    assert.equal(data.plugins[0].options.providers.qoder.enabled, false);
    assert.equal(data.plugins[0].package, specifier(catalog[0].id, revision));
    assert.equal(data.plugins[1], "foreign-package");
});

test("uninstall removes both Goal entrances and preserves other state", () => {
    const cfg = configs().map(c => ({ ...c, data: { plugins: [specifier("opencode-goal", "main"), "other"] }, original: JSON.stringify({ plugins: [specifier("opencode-goal", "main"), "other"], keep: true }) }));
    const changes = planChanges(cfg, [catalog[1]], "remove");
    for (const c of changes) { assert.deepEqual(parse(c.next).plugins, ["other"]); assert.equal(parse(c.next).keep, true); }
});

test("status distinguishes latest, update, absent, incomplete and failed checks", () => {
    const cfg = configs();
    cfg[0].data.plugins = [specifier("opencode-providers", "main"), specifier("opencode-goal", revision)];
    cfg[2].data.plugins = [specifier("opencode-message-delete", older)];
    const trees = new Map([
        [revision, new Map([["plugins/opencode-providers", "same"], ["plugins/opencode-message-delete", "new"]])],
        [revision.slice(0,7), new Map([["plugins/opencode-providers", "same"]])],
        [older, new Map([["plugins/opencode-message-delete", "old"]])],
    ]);
    const state = statuses(cfg, revision, `opencode-providers ${revision.slice(0,7)} ${specifier("opencode-providers", "main")}`, trees);
    assert.deepEqual(state.map(p => p.state), ["current", "repair", "update", "absent", "absent", "absent", "absent", "absent"]);
    assert.equal(statuses(cfg, undefined)[0].state, "unknown");
    assert.equal(statuses(cfg, revision)[0].state, "repair");
});

test("only this GitHub repository's known plugin subpaths are managed", () => {
    assert.equal(identify("opencode-goal"), undefined);
    assert.equal(identify("git+https://github.com/other/opencode-plugins.git#main::path:opencode-goal"), undefined);
    assert.equal(identify("github:nichem/opencode-plugins#main::path:opencode-goal").id, "opencode-goal");
});

test("UI enhancement installs only in cli.json and preserves options and other plugins", () => {
    const ui = catalog.find(plugin => plugin.id === "opencode-ui");
    const changes = planChanges(configs(), [ui], "install", revision);
    assert.deepEqual(changes.map(config => config.path), ["cli.json"]);
    assert.deepEqual(parse(changes[0].next).plugins, [specifier(ui.id, revision)]);
    const data = { plugins: ["foreign", { package: specifier(ui.id, older), options: { thinkingTimer: false } }], theme: "fixture" };
    const config = { kind: "tui", path: "cli.json", original: JSON.stringify(data), data };
    const updated = parse(planChanges([config], [ui], "install", revision)[0].next);
    assert.deepEqual(updated.plugins, ["foreign", { package: specifier(ui.id, revision), options: { thinkingTimer: false } }]);
    assert.deepEqual(parse(planChanges([config], [ui], "remove")[0].next), { plugins: ["foreign"], theme: "fixture" });
});

test("quota installs both entrances, preserves script options on update and removes only its entries", () => {
    const quota = catalog.find(plugin => plugin.id === "opencode-quota");
    const initial = configs();
    const installed = planChanges(initial, [quota], "install", revision);
    assert.deepEqual(installed.map(config => config.path), ["opencode.json", "cli.json"]);
    for (const entry of installed) assert.deepEqual(parse(entry.next).plugins, [specifier(quota.id, revision)]);
    const config = { kind: "server", path: "opencode.jsonc", original: "", data: {} };
    config.data = { plugins: [{ package: specifier(quota.id, older), options: { providers: { fixture: { script: "./quota.mjs" } } } }, "other"] };
    config.original = JSON.stringify(config.data);
    const updated = planChanges([config], [quota], "install", revision)[0];
    assert.deepEqual(parse(updated.next).plugins[0].options, config.data.plugins[0].options);
    const removed = planChanges([config], [quota], "remove")[0];
    assert.deepEqual(parse(removed.next).plugins, ["other"]);
});

test("websearch installs both entrances and uninstall preserves unrelated configuration", () => {
    const search = catalog.find(plugin => plugin.id === "opencode-websearch");
    const initial = configs();
    const changes = planChanges(initial, [search], "install", revision);
    assert.deepEqual(changes.map(config => config.path), ["opencode.json", "cli.json"]);
    for (const change of changes) assert.deepEqual(parse(change.next).plugins, [specifier(search.id, revision)]);
    const configured = changes.map(change => ({ ...change, original: change.next,
        data: { ...parse(change.next), websearch: { provider: "tavily" } } }));
    for (const config of configured) config.original = JSON.stringify({ ...config.data, plugins: [...config.data.plugins, "foreign"] });
    for (const config of configured) config.data = parse(config.original);
    for (const change of planChanges(configured, [search], "remove")) {
        assert.deepEqual(parse(change.next).plugins, ["foreign"]);
        assert.deepEqual(parse(change.next).websearch, { provider: "tavily" });
    }
});

test("DeepSeek behavior manages both entrances while preserving JSONC, plugin options and other configuration", () => {
    const behavior = catalog.find(plugin => plugin.id === "opencode-deepseek-behavior");
    const changes = planChanges(configs(), [behavior], "install", revision);
    assert.deepEqual(changes.map(config => config.path), ["opencode.json", "cli.json"]);
    for (const change of changes) assert.deepEqual(parse(change.next).plugins, [specifier(behavior.id, revision)]);
    const original = '{\n // fixture comment\n "plugins":["foreign",{"package":"' + specifier(behavior.id, older) + '","options":{"fixture":true}}],"keep":true\n}';
    const config = { kind: "server", path: "opencode.jsonc", original, data: parse(original) };
    const updated = planChanges([config], [behavior], "install", revision)[0].next;
    assert.match(updated, /fixture comment/);
    assert.deepEqual(parse(updated), { plugins: ["foreign", { package: specifier(behavior.id, revision), options: { fixture: true } }], keep: true });
    assert.deepEqual(parse(planChanges([config], [behavior], "remove")[0].next), { plugins: ["foreign"], keep: true });
    const installed = configs();
    installed[0].data.plugins = [specifier(behavior.id, revision)];
    assert.equal(statuses(installed, revision).find(plugin => plugin.id === behavior.id).state, "repair");
    installed[2].data.plugins = [specifier(behavior.id, revision)];
    assert.equal(statuses(installed, revision).find(plugin => plugin.id === behavior.id).state, "current");
});

test("disk changes make backups, preserve concurrent edits and roll back earlier files", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-installer-test-"));
    try {
        const paths = { server: [join(root, "opencode.jsonc")], tui: [join(root, "cli.json")] };
        await writeFile(paths.server[0], '{"plugins":[],"keep":true}');
        const configs = await readConfigs(paths);
        const changes = planChanges(configs, [catalog[1]], "install", revision);
        await writeFile(paths.tui[0], '{"user":"new change"}');
        await assert.rejects(writeChanges(changes, join(root, "backups")), /其他程序修改/);
        assert.equal(await readFile(paths.server[0], "utf8"), configs[0].original);
        assert.equal(await readFile(paths.tui[0], "utf8"), '{"user":"new change"}');
        const fresh = await readConfigs(paths);
        const backup = await writeChanges(planChanges(fresh, [catalog[1]], "install", revision), join(root, "backups"));
        assert.equal(await readFile(join(backup, "0.json.bak"), "utf8"), configs[0].original);
        assert.equal(JSON.parse(await readFile(paths.tui[0], "utf8")).user, "new change");
    } finally {
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true, force: true });
    }
});
