import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "jsonc-parser";
import { catalog, identify, specifier } from "../catalog.js";
import { planChanges, readConfigs, writeChanges } from "../config.js";
import { statuses } from "../status.js";
const revision = "a".repeat(40), older = "b".repeat(40);
const configs = () => [
    { kind: "server", path: "opencode.json", original: "{}", data: {} },
    { kind: "server", path: "opencode.jsonc", original: null, data: {} },
    { kind: "tui", path: "cli.json", original: "{}", data: {} },
];

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
        [revision, new Map([["opencode-providers", "same"], ["opencode-message-delete", "new"]])],
        [revision.slice(0,7), new Map([["opencode-providers", "same"]])],
        [older, new Map([["opencode-message-delete", "old"]])],
    ]);
    const state = statuses(cfg, revision, `opencode-providers ${revision.slice(0,7)} ${specifier("opencode-providers", "main")}`, trees);
    assert.deepEqual(state.map(p => p.state), ["current", "repair", "update", "absent"]);
    assert.equal(statuses(cfg, undefined)[0].state, "unknown");
    assert.equal(statuses(cfg, revision)[0].state, "repair");
});

test("only this GitHub repository's known plugin subpaths are managed", () => {
    assert.equal(identify("opencode-goal"), undefined);
    assert.equal(identify("git+https://github.com/other/opencode-plugins.git#main::path:opencode-goal"), undefined);
    assert.equal(identify("github:nichem/opencode-plugins#main::path:opencode-goal").id, "opencode-goal");
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
