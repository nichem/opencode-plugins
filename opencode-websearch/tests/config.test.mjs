import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { parse } from "jsonc-parser";
import { ProjectConfiguration } from "../src/config.js";

async function fixture(work) {
    const root = await mkdtemp(join(tmpdir(), "websearch-config-"));
    const project = join(root, "project"), backupRoot = join(root, "backups");
    await mkdir(project);
    try { await work(new ProjectConfiguration(project, { backupRoot }), project, backupRoot); }
    finally {
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true, force: true });
    }
}
test("a default save preserves JSONC comments, other plugins, fields, and an exact external backup", async () => fixture(async (config, project, backups) => {
    const original = '{\n // retain\n "plugins": ["other"], "websearch": {\n // search options\n "provider": "exa", "futureOption": true\n }, "fixtureSecret": "fixture-only",\n}\n';
    const path = join(project, "opencode.jsonc");
    await writeFile(path, original);
    assert.equal(await config.write("dss"), true);
    const updated = await readFile(path, "utf8"), data = parse(updated);
    assert.match(updated, /\/\/ retain/);
    assert.match(updated, /\/\/ search options/);
    assert.deepEqual(data.plugins, ["other"]);
    assert.deepEqual(data.websearch, { provider: "dss", futureOption: true });
    assert.equal(data.fixtureSecret, "fixture-only");
    const backup = join(backups, (await readdir(backups))[0]);
    assert.equal(await readFile(join(backup, "config.json.bak"), "utf8"), original);
    assert.equal(JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")).path, path);
    assert.equal(await config.write("dss"), false);
    assert.equal((await readdir(backups)).length, 1);
}));
test("JSONC takes precedence, the lower priority JSON is preserved, and an empty project gets JSONC", async () => fixture(async (config, project) => {
    assert.equal(await config.read(), undefined);
    await config.write("random");
    assert.deepEqual(parse(await readFile(join(project, "opencode.jsonc"), "utf8")), { websearch: { provider: "random" } });
    await writeFile(join(project, "opencode.json"), '{"websearch":{"provider":"exa"},"keep":true}');
    assert.equal(await config.read(), "random");
    await config.write("tavily");
    assert.equal(await config.read(), "tavily");
    assert.equal(JSON.parse(await readFile(join(project, "opencode.json"), "utf8")).websearch.provider, "exa");
}));
test("disabled search is changed only by an explicit save and malformed configurations are left untouched", async () => fixture(async (config, project) => {
    const path = join(project, "opencode.json");
    await writeFile(path, '{"websearch":false,"keep":true}');
    assert.equal(await config.read(), false);
    await config.write("random");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { websearch: { provider: "random" }, keep: true });
    await writeFile(path, '{"websearch":');
    await assert.rejects(config.write("dss"), /配置格式错误/);
    assert.equal(await readFile(path, "utf8"), '{"websearch":');
}));
test("concurrent edits to either configuration file abort the write", async () => fixture(async (config, project) => {
    const path = join(project, "opencode.json");
    await writeFile(path, '{"keep":true}');
    const snapshot = config.snapshot.bind(config);
    config.snapshot = async () => {
        const documents = await snapshot();
        await writeFile(join(project, "opencode.jsonc"), '{"newer":true}');
        return documents;
    };
    await assert.rejects(config.write("dss"), /其他程序修改/);
    assert.equal(await readFile(path, "utf8"), '{"keep":true}');
    assert.equal(await readFile(join(project, "opencode.jsonc"), "utf8"), '{"newer":true}');
}));

test("a local .opencode config takes priority and is updated without touching direct configs", async () => fixture(async (config, project, backups) => {
    const direct = '{"websearch":{"provider":"exa"},"plugins":["keep"]}';
    await writeFile(join(project, "opencode.jsonc"), direct);
    await mkdir(join(project, ".opencode"));
    const path = join(project, ".opencode", "opencode.jsonc");
    const original = '{\n // nested selection\n "websearch": {"provider":"tavily","keep":true}, "other":true\n}';
    await writeFile(path, original);
    assert.equal(await config.read(), "tavily");
    await config.write("dss");
    assert.equal(await config.read(), "dss");
    assert.equal(await readFile(join(project, "opencode.jsonc"), "utf8"), direct);
    assert.deepEqual(parse(await readFile(path, "utf8")), { websearch: { provider: "dss", keep: true }, other: true });
    assert.match(await readFile(path, "utf8"), /nested selection/);
    const backup = join(backups, (await readdir(backups))[0]);
    assert.equal(await readFile(join(backup, "config.json.bak"), "utf8"), original);
}));

test("effective search state follows native global, parent, and local source order", async () => fixture(async (config, project) => {
    await writeFile(join(project, "opencode.json"), '{"keep":true}');
    const sources = [{ path: "/fixture/global/opencode.json", websearch: false },
        { path: join(project, "opencode.json"), websearch: undefined }];
    config.sources = async () => sources;
    assert.equal(await config.read(), false);
    sources.push({ path: "/fixture/parent/.opencode/opencode.json", websearch: { provider: "tavily" } });
    assert.equal(await config.read(), "tavily");
    sources.push({ path: join(project, ".opencode", "opencode.jsonc"), websearch: false });
    assert.equal(await config.read(), false);
}));

test("an inherited .opencode selection gets a local override without modifying the parent", async () => fixture(async (config, project) => {
    const parent = dirname(project), inheritedDirectory = join(parent, ".opencode");
    await mkdir(inheritedDirectory);
    const inherited = join(inheritedDirectory, "opencode.jsonc"), original = '{"websearch":{"provider":"exa"}}';
    await writeFile(inherited, original);
    await writeFile(join(project, "opencode.json"), '{"keep":true}');
    config.sources = async () => [{ path: inherited, websearch: { provider: "exa" } }];
    await config.write("tavily");
    assert.deepEqual(parse(await readFile(join(project, ".opencode", "opencode.jsonc"), "utf8")), { websearch: { provider: "tavily" } });
    assert.equal(await readFile(inherited, "utf8"), original);
    assert.equal(await readFile(join(project, "opencode.json"), "utf8"), '{"keep":true}');
}));

test("a concurrent new .opencode config aborts saving to a direct config", async () => fixture(async (config, project) => {
    const direct = join(project, "opencode.json");
    await writeFile(direct, '{"keep":true}');
    const snapshot = config.snapshot.bind(config);
    config.snapshot = async () => {
        const documents = await snapshot();
        await mkdir(join(project, ".opencode"));
        await writeFile(join(project, ".opencode", "opencode.json"), '{"websearch":false}');
        return documents;
    };
    await assert.rejects(config.write("dss"), /其他程序修改/);
    assert.equal(await readFile(direct, "utf8"), '{"keep":true}');
}));
