import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { catalog, specifier } from "../catalog.js";
import { readConfigs } from "../config.js";
import { preparePackages, applySelection } from "../install.js";
import { opencode } from "../status.js";

const revision = "a".repeat(40);
const selected = [catalog[0], catalog[2]];
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "opencode-install-test-"));
    t.after(async () => {
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true, force: true });
    });
    return root;
}

test("native preinstallation isolates configuration, preserves cache/locks and deduplicates packages", async () => {
    const env = { PATH: "fixture-path", XDG_CACHE_HOME: "fixture-cache", XDG_STATE_HOME: "fixture-state",
        XDG_CONFIG_HOME: "real-config", XDG_DATA_HOME: "real-data", OPENCODE_CONFIG_DIR: "real-dir",
        OPENCODE_CONFIG: "real.json", OPENCODE_CONFIG_CONTENT: "fixture", OPENCODE_CLI_CONFIG_CONTENT: "fixture", OPENCODE_DB: "real.db" };
    const calls = [];
    await preparePackages([...selected, selected[0]], revision, { env, run: async (command, options) => {
        calls.push(options);
        assert.equal(command, "add");
        assert.ok(options.target.endsWith(`::path:plugins/${selected[calls.length - 1].id}`));
        assert.equal(options.env.XDG_CACHE_HOME, env.XDG_CACHE_HOME);
        assert.equal(options.env.XDG_STATE_HOME, env.XDG_STATE_HOME);
        assert.equal(options.env.PATH, env.PATH);
        for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CLI_CONFIG_CONTENT", "OPENCODE_DB"])
            assert.equal(options.env[key], undefined);
        assert.notEqual(options.env.OPENCODE_CONFIG_DIR, env.OPENCODE_CONFIG_DIR);
        assert.notEqual(options.env.XDG_DATA_HOME, env.XDG_DATA_HOME);
        assert.equal(await readFile(join(options.env.OPENCODE_CONFIG_DIR, "cli.json"), "utf8"), "{}\n");
        await writeFile(join(options.env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify({ plugins: [options.target] }));
    } });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].target, specifier(selected[0].id, revision));
    assert.equal(calls[0].cwd, calls[1].cwd);
    await assert.rejects(access(calls[0].cwd), { code: "ENOENT" });
    assert.equal(env.OPENCODE_CONFIG_DIR, "real-dir");
});

test("failed preparation removes temporary config and never writes live config or backups", async t => {
    const root = await fixture(t), path = join(root, "opencode.json"), backups = join(root, "backups");
    const original = '{"plugins":["foreign"],"keep":true}';
    await writeFile(path, original);
    const configs = await readConfigs({ server: [path] });
    let temporary;
    await assert.rejects(applySelection(configs, selected, "install", revision, backups, {
        prepare: (plugins, ref) => preparePackages(plugins, ref, { run: async (_command, options) => {
            temporary = options.cwd; throw new Error("fixture failure");
        } }),
    }), /未修改配置/);
    assert.equal(await readFile(path, "utf8"), original);
    await assert.rejects(access(backups), { code: "ENOENT" });
    await assert.rejects(access(temporary), { code: "ENOENT" });
});

test("configuration and backup writes wait for preparation, then preserve options", async t => {
    const root = await fixture(t), path = join(root, "opencode.json"), backups = join(root, "backups");
    const original = JSON.stringify({ plugins: [{ package: specifier(selected[0].id, "b".repeat(40)), options: { fixture: true } }, "foreign"] });
    await writeFile(path, original);
    const configs = await readConfigs({ server: [path] });
    const gate = Promise.withResolvers();
    const operation = applySelection(configs, [selected[0]], "install", revision, backups, { prepare: () => gate.promise });
    assert.equal(await readFile(path, "utf8"), original);
    await assert.rejects(access(backups), { code: "ENOENT" });
    gate.resolve();
    const backup = await operation;
    assert.equal(await readFile(join(backup, "0.json.bak"), "utf8"), original);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).plugins,
        [{ package: specifier(selected[0].id, revision), options: { fixture: true } }, "foreign"]);
});

test("concurrent edits during preparation are still rejected and uninstall does not download", async t => {
    const root = await fixture(t), path = join(root, "opencode.json");
    await writeFile(path, "{}");
    const configs = await readConfigs({ server: [path] });
    await assert.rejects(applySelection(configs, [selected[0]], "install", revision, join(root, "backups"), {
        prepare: () => writeFile(path, '{"concurrent":true}'),
    }), /其他程序修改/);
    assert.equal(await readFile(path, "utf8"), '{"concurrent":true}');
    await writeFile(path, JSON.stringify({ plugins: [specifier(selected[0].id, revision), "foreign"] }));
    await applySelection(await readConfigs({ server: [path] }), [selected[0]], "remove", undefined, join(root, "backups"), {
        prepare: () => assert.fail("uninstall must not download"),
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).plugins, ["foreign"]);
});

test("invalid references and shell characters cannot reach OpenCode", async () => {
    await assert.rejects(preparePackages(selected, "main"), /无效/);
    await assert.rejects(preparePackages([{ id: "foreign" }], revision), /无效/);
    for (const target of [specifier(selected[0].id, "main"), specifier(selected[0].id, revision) + " & echo unsafe", "foreign"])
        await assert.rejects(opencode("add", { target }), /无效/);
});
