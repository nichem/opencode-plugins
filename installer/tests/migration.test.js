import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import { catalog, identify, pluginPath, repo, specifier } from "../catalog.js";
import { planChanges, readConfigs, writeChanges } from "../config.js";
import { gitRevisionTrees, loadVersionTrees, revisionTrees, statuses } from "../status.js";

const old = "a".repeat(40), latest = "b".repeat(40), root = "c".repeat(40), container = "d".repeat(40), hash = "e".repeat(40);
const legacy = (id, ref = old) => `git+${repo}#${ref}::path:${id}`;
const config = (kind, entries) => {
    const original = JSON.stringify({ plugins: entries, keep: true });
    return { kind, path: kind === "tui" ? "cli.json" : "opencode.jsonc", original, data: parse(original) };
};
const select = id => catalog.find(plugin => plugin.id === id);
const state = (configs, trees, installed = "") => statuses(configs, latest, installed, trees).find(plugin => plugin.id === "opencode-goal");

test("both directory layouts and supported GitHub aliases identify the same plugin with distinct source paths", () => {
    for (const prefix of [`git+${repo}`, "git+https://github.com/nichem/opencode-plugins", "github:nichem/opencode-plugins", "nichem/opencode-plugins"]) {
        for (const path of ["opencode-goal", "plugins/opencode-goal"]) {
            const source = `${prefix}#main::path:${path}/`;
            assert.deepEqual(identify(source), { id: "opencode-goal", revision: "main", path });
            assert.deepEqual(identify({ package: source, options: { fixture: true } }), identify(source));
        }
    }
    for (const path of ["unknown", "plugins/unknown", "plugins/plugins/opencode-goal", "../opencode-goal", "plugins/opencode-goal/src", "plugins//opencode-goal"])
        assert.equal(identify(`git+${repo}#main::path:${path}`), undefined);
    assert.equal(identify("opencode-goal"), undefined);
    assert.equal(identify("git+https://github.com/other/opencode-plugins.git#main::path:plugins/opencode-goal"), undefined);
});

test("legacy server and TUI entries migrate in place, preserving comments, foreign plugins and options", () => {
    const original = `{
  // configuration comment
  "plugins": [
    "foreign-first",
    {
      // package comment
      "package": "${legacy("opencode-goal", "main")}",
      "options": { /* option comment */ "fixture": true }
    },
    // foreign plugin comment
    "foreign-last"
  ], "keep": true
}`;
    const configs = [
        { kind: "server", path: "opencode.jsonc", original, data: parse(original) },
        config("tui", [legacy("opencode-goal")]),
    ];
    const changes = planChanges(configs, [select("opencode-goal")], "install", latest);
    assert.equal(changes.length, 2);
    for (const change of changes) assert.equal(identify(parse(change.next).plugins.find(entry => identify(entry))).path, pluginPath("opencode-goal"));
    const migrated = changes[0].next;
    for (const comment of ["configuration comment", "package comment", "option comment", "foreign plugin comment"]) assert.ok(migrated.includes(comment));
    assert.deepEqual(parse(migrated), { plugins: ["foreign-first", { package: specifier("opencode-goal", latest), options: { fixture: true } }, "foreign-last"], keep: true });
});

test("mixed old/new duplicates merge compatible options, keep their first position and uninstall together", () => {
    const id = "opencode-quota", plugin = select(id);
    const cfg = config("server", ["first", { package: legacy(id), options: { providers: { fixture: { script: "./quota.mjs" } } } },
        "middle", { package: specifier(id, latest), options: { refreshMs: 12345 } }, legacy(id, "main"), "last"]);
    const next = parse(planChanges([cfg], [plugin], "install", latest)[0].next);
    assert.deepEqual(next.plugins, ["first", { package: specifier(id, latest), options: {
        providers: { fixture: { script: "./quota.mjs" } }, refreshMs: 12345,
    } }, "middle", "last"]);
    assert.deepEqual(parse(planChanges([cfg], [plugin], "remove")[0].next), { plugins: ["first", "middle", "last"], keep: true });
});

test("conflicting duplicate options stop migration without disclosing values; uninstall remains possible", () => {
    const id = "opencode-goal", plugin = select(id);
    const cfg = config("server", [{ package: legacy(id), options: { fixture: "private-fixture-one" } },
        { package: specifier(id, latest), options: { fixture: "private-fixture-two" } }]);
    const original = cfg.original;
    assert.throws(() => planChanges([cfg], [plugin], "install", latest), error => /冲突/.test(error.message) && !error.message.includes("private-fixture"));
    assert.equal(cfg.original, original);
    assert.deepEqual(parse(planChanges([cfg], [plugin], "remove")[0].next).plugins, []);
});

test("removing first, middle, last and sole entries keeps JSONC valid, including trailing commas and comments", () => {
    const source = JSON.stringify(legacy("opencode-goal"));
    const arrays = [`[${source}]`, `[${source},]`, `[${source},"other"]`, `["other",${source}]`,
        `["other",${source},]`, `["first",${source},"last"]`, `["first", /* retained comment */ ${source}, "last"]`,
        `["other", {"package":${source},"options":{"fixture":true}}]`];
    for (const array of arrays) {
        const original = `{// header comment\n"plugins":${array},"keep":true}`;
        const cfg = { kind: "server", path: "fixture.jsonc", original, data: parse(original) };
        const next = planChanges([cfg], [select("opencode-goal")], "remove")[0].next;
        const errors = [], data = parse(next, errors, { allowTrailingComma: true });
        assert.deepEqual(errors, []);
        assert.deepEqual(data, { plugins: cfg.data.plugins.filter(entry => !identify(entry)), keep: true });
        assert.match(next, /header comment/);
        if (original.includes("retained comment")) assert.match(next, /retained comment/);
    }
});

test("unchanged content at a legacy path still offers migration and each entrance uses its actual source path", () => {
    const configs = [config("server", [legacy("opencode-goal")]), config("tui", [specifier("opencode-goal", latest)])];
    const trees = new Map([[old, new Map([["opencode-goal", hash]])], [latest, new Map([[pluginPath("opencode-goal"), hash]])]]);
    assert.deepEqual([state(configs, trees).state, state(configs, trees).label], ["repair", "旧目录地址 · 需要迁移"]);
    trees.get(latest).set(pluginPath("opencode-goal"), "changed");
    assert.deepEqual([state(configs, trees).state, state(configs, trees).label], ["update", "有更新 · 需要迁移"]);
    trees.get(old).clear();
    trees.get(old).set(pluginPath("opencode-goal"), "changed");
    assert.equal(state(configs, trees).state, "unknown", "a new-path hash must not be borrowed for a legacy installation");
    const missingEntrance = [configs[0]];
    assert.equal(state(missingEntrance, trees).state, "repair");
});

test("old main cache versions never borrow the new main address's cached commit", async () => {
    const id = "opencode-goal", oldSource = legacy(id, "main"), newSource = specifier(id, "main");
    const configs = [config("server", [oldSource]), config("tui", [newSource])];
    const cached = `- ${latest} ${newSource}`;
    assert.equal(state(configs, new Map(), cached).state, "repair");
    const installed = `- ${old.slice(0, 7)} ${oldSource}\n${cached}`;
    const trees = await loadVersionTrees(configs, latest, installed, async ref => new Map([[ref === latest ? pluginPath(id) : id, hash]]));
    assert.match(state(configs, trees, installed).label, /需要迁移/);
});

test("API reads only root and plugins container trees and keeps legacy hashes distinct", async () => {
    const urls = [];
    const responses = [[{ sha: latest, commit: { tree: { sha: root } } }], { tree: [
        { path: "plugins", type: "tree", sha: container }, { path: "opencode-goal", type: "tree", sha: old },
    ] }, { tree: [
        { path: "opencode-goal", type: "tree", sha: hash }, { path: "opencode-agents", type: "tree", sha: hash },
        { path: "unknown", type: "tree", sha: old }, { path: "README.md", type: "blob", sha: old },
    ] }];
    const trees = await revisionTrees(latest, async url => {
        urls.push(url);
        return { ok: true, json: async () => responses.shift() };
    });
    assert.deepEqual([...trees], [["opencode-goal", old], [pluginPath("opencode-goal"), hash], [pluginPath("opencode-agents"), hash]]);
    assert.deepEqual(urls.map(url => url.split("/opencode-plugins/")[1]), [
        `commits?sha=${latest}&per_page=1`, `git/trees/${root}`, `git/trees/${container}`,
    ]);
    assert.ok(urls.every(url => !url.includes("recursive") && !url.includes(`/git/trees/${hash}`)));
});

test("an incomplete plugins container cannot imply latest", async () => {
    const responses = [[{ sha: latest, commit: { tree: { sha: root } } }],
        { tree: [{ path: "plugins", type: "tree", sha: container }] }, { truncated: true, tree: [] }];
    await assert.rejects(revisionTrees(latest, async () => ({ ok: true, json: async () => responses.shift() })), /不完整/);
});

test("on-disk legacy migration backs up original JSONC and uninstall preserves unrelated state files", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-migration-config-"));
    try {
        const server = join(root, "opencode.jsonc"), tui = join(root, "cli.json");
        const original = `{// fixture comment\n"plugins":["foreign","${legacy("opencode-goal")}"],"keep":true}`;
        await writeFile(server, original);
        await writeFile(tui, JSON.stringify({ plugins: [legacy("opencode-goal")] }));
        const retained = join(root, "plugin-state.json");
        await writeFile(retained, '{"enabled":false}');
        const paths = { server: [server], tui: [tui] }, selected = [select("opencode-goal")];
        const before = await readConfigs(paths);
        const backup = await writeChanges(planChanges(before, selected, "install", latest), join(root, "backups"));
        assert.equal(await readFile(join(backup, "0.json.bak"), "utf8"), original);
        const after = await readConfigs(paths);
        assert.equal(statuses(after, latest).find(plugin => plugin.id === "opencode-goal").state, "current");
        await writeChanges(planChanges(after, selected, "remove"), join(root, "backups"));
        assert.deepEqual(parse(await readFile(server, "utf8")), { plugins: ["foreign"], keep: true });
        assert.equal(await readFile(retained, "utf8"), '{"enabled":false}');
    } finally {
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true, force: true });
    }
});

test("real Git compares pre-move and post-move directories without fetching any plugin trees or document blobs", async () => {
    const source = await mkdtemp(join(tmpdir(), "opencode-migration-git-"));
    const exec = promisify(execFile);
    const git = async args => (await exec("git", ["-C", source, ...args], { windowsHide: true })).stdout.trim();
    const commit = async () => {
        await git(["add", "."]);
        await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
        return git(["rev-parse", "HEAD"]);
    };
    try {
        await git(["init", "--quiet", "--initial-branch=main"]);
        await git(["config", "uploadpack.allowFilter", "true"]);
        await git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
        await mkdir(join(source, "opencode-goal"));
        await mkdir(join(source, "opencode-agents", "agents"), { recursive: true });
        await writeFile(join(source, "opencode-goal", "index.js"), "export default 1;\n");
        await writeFile(join(source, "opencode-agents", "agents", "fixture.md"), "Artificial document; never fetch this blob.\n");
        const before = await commit();
        await mkdir(join(source, "plugins"));
        for (const id of ["opencode-goal", "opencode-agents"]) await rename(join(source, id), join(source, "plugins", id));
        const after = await commit();
        const expected = await git(["rev-parse", `${before}:opencode-goal`]);
        const allowed = new Set(await Promise.all([`${before}^{tree}`, `${after}^{tree}`, `${after}:plugins`].map(ref => git(["rev-parse", ref]))));
        const trees = await gitRevisionTrees([before, after], { run: async (file, args, options) => {
            const result = await exec(file, args.map(arg => arg === repo ? pathToFileURL(source).href : arg), options);
            if (args.includes("ls-tree")) {
                assert.ok(allowed.has(args.at(-1)));
                assert.ok(!args.includes("-r"));
                const objects = (await exec(file, ["-C", args[1], "cat-file", "--batch-all-objects", "--batch-check=%(objecttype) %(objectname)"], options)).stdout.trim().split(/\r?\n/);
                assert.ok(objects.every(line => line.startsWith("commit ") || line.startsWith("tree ") && allowed.has(line.slice(5))));
            }
            return result;
        } });
        assert.equal(trees.get(before).get("opencode-goal"), expected);
        assert.equal(trees.get(after).get(pluginPath("opencode-goal")), expected);
        const configs = [config("server", [legacy("opencode-goal", before)]), config("tui", [specifier("opencode-goal", after)])];
        assert.match(statuses(configs, after, "", trees).find(plugin => plugin.id === "opencode-goal").label, /需要迁移/);
    } finally {
        assert.ok(resolve(source).startsWith(resolve(tmpdir()) + sep));
        await rm(source, { recursive: true, force: true });
    }
});
