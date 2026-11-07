import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access, symlink, utimes } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { BACKUP_LIMIT, pruneBackups } from "../backups.js";
import { writeChanges } from "../config.js";

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "opencode-backups-test-"));
    t.after(async () => {
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true, force: true });
    });
    return root;
}
async function backup(root, time, contents = {}) {
    const directory = join(root, `${time}-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "manifest.json"), JSON.stringify([{ path: "fixture.json", backup: "0.json.bak" }]));
    await writeFile(join(directory, "0.json.bak"), JSON.stringify(contents));
    return directory;
}

test("successful writes retain ten operation backups, each containing all changed configs", async t => {
    const root = await fixture(t), backups = join(root, "backups");
    const paths = [join(root, "opencode.json"), join(root, "cli.json")];
    for (const path of paths) await writeFile(path, "0");
    let current;
    for (let i = 1; i <= BACKUP_LIMIT + 2; i++) {
        current = await writeChanges(paths.map(path => ({ path, original: String(i - 1), next: String(i) })), backups);
    }
    assert.equal((await readdir(backups)).length, BACKUP_LIMIT);
    for (const i of [0, 1]) assert.equal(await readFile(join(current, `${i}.json.bak`), "utf8"), String(BACKUP_LIMIT + 1));
    const generations = await Promise.all((await readdir(backups)).map(name => readFile(join(backups, name, "0.json.bak"), "utf8")));
    assert.deepEqual(generations.map(Number).sort((a, b) => a - b), Array.from({ length: BACKUP_LIMIT }, (_, i) => i + 2));
});

test("cleanup uses creation names instead of modified times and protects the current backup after clock rollback", async t => {
    const root = await fixture(t);
    const oldest = await backup(root, 1700000000000);
    const newer = await backup(root, 1700000000001);
    const newest = await backup(root, 1700000000002);
    await utimes(oldest, new Date(), new Date());
    await pruneBackups(root, { limit: 2 });
    await assert.rejects(access(oldest), { code: "ENOENT" });
    await access(newer); await access(newest);
    const current = await backup(root, 1600000000000);
    await pruneBackups(root, { limit: 2, keep: current });
    await access(current); await access(newest);
    await assert.rejects(access(newer), { code: "ENOENT" });
});

test("foreign files, malformed manifests, unexpected children and directory links are preserved", async t => {
    const root = await fixture(t), backups = join(root, "backups");
    const outside = join(root, "outside");
    await mkdir(outside); await writeFile(join(outside, "keep.txt"), "fixture");
    await mkdir(backups); await writeFile(join(backups, "notes.txt"), "fixture");
    const odd = await backup(backups, 1700000000000);
    await writeFile(join(odd, "keep.txt"), "fixture");
    const broken = await backup(backups, 1700000000001);
    await writeFile(join(broken, "manifest.json"), "invalid json");
    const nested = await backup(backups, 1700000000002);
    await mkdir(join(nested, "nested"));
    const link = join(backups, `1700000000003-${randomUUID()}`);
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    const old = await backup(backups, 1700000000004);
    const retained = await backup(backups, 1700000000005);
    await pruneBackups(backups, { limit: 1 });
    for (const path of [odd, broken, nested, link, retained, join(backups, "notes.txt")]) await access(path);
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "fixture");
    await assert.rejects(access(old), { code: "ENOENT" });
});

test("failed or empty config writes do not prune existing backups", async t => {
    const root = await fixture(t), backups = join(root, "backups"), path = join(root, "opencode.json");
    const old = await backup(backups, 1700000000000), newer = await backup(backups, 1700000000001);
    await writeFile(path, "concurrent edit");
    await assert.rejects(writeChanges([{ path, original: "before", next: "after" }], backups, { backupLimit: 1 }), /其他程序修改/);
    await writeChanges([], backups, { backupLimit: 1 });
    await access(old); await access(newer);
    assert.equal(await readFile(path, "utf8"), "concurrent edit");
});

test("invalid retention limits are rejected before configuration changes", async t => {
    const root = await fixture(t), path = join(root, "opencode.json");
    await writeFile(path, "before");
    for (const backupLimit of [0, -1, 1.5, NaN])
        await assert.rejects(writeChanges([{ path, original: "before", next: "after" }], join(root, "backups"), { backupLimit }), /正整数/);
    assert.equal(await readFile(path, "utf8"), "before");
});
