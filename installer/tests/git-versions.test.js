import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gitRevisionTrees, loadVersionTrees, statuses } from "../status.js";
import { repo, specifier } from "../catalog.js";

const exec = promisify(execFile);

async function removeTemporary(directory) {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
}

test("Git fallback compares real root trees using commits and root trees only, including short cache IDs", async () => {
    const source = await mkdtemp(join(tmpdir(), "opencode-version-fixture-"));
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
        await mkdir(join(source, "opencode-providers"));
        await mkdir(join(source, "opencode-agents", "agents"), { recursive: true });
        await writeFile(join(source, "opencode-providers", "index.js"), "export default 1;\n");
        await writeFile(join(source, "opencode-agents", "agents", "fixture.md"), "Artificial test document; never download this blob.\n");
        const old = await commit();
        await writeFile(join(source, "README.md"), "Unrelated fixture change\n");
        const unchanged = await commit();
        await writeFile(join(source, "opencode-providers", "index.js"), "export default 2;\n");
        const latest = await commit();
        for (const refs of [[old, unchanged, latest, latest], [old.slice(0, 7), unchanged.slice(0, 7), latest],
            [old.slice(0, 7), latest.slice(0, 7)], [old, latest.slice(0, 7)]]) {
            let temporary, types;
            const commands = [];
            const run = async (file, args, options) => {
                commands.push(args);
                temporary = args[1];
                assert.equal(options.env.GIT_NO_LAZY_FETCH, "1");
                const result = await exec(file, args.map(arg => arg === repo ? pathToFileURL(source).href : arg), options);
                if (args.includes("ls-tree")) {
                    types = (await exec(file, ["-C", temporary, "cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"], options)).stdout.trim().split(/\s+/);
                }
                return result;
            };
            const trees = await gitRevisionTrees(refs, { run });
            const first = trees.get(refs[0]), last = trees.get(refs.at(-1));
            assert.equal(trees.size, new Set(refs).size);
            assert.equal(first.get("opencode-agents"), last.get("opencode-agents"));
            assert.notEqual(first.get("opencode-providers"), last.get("opencode-providers"));
            if (refs.length > 2) assert.equal(first.get("opencode-providers"), trees.get(refs[1]).get("opencode-providers"));
            assert.equal(types.filter(type => type === "tree").length, new Set(refs).size);
            assert.ok(types.every(type => type === "commit" || type === "tree"), "no document blobs are fetched");
            assert.ok(commands.filter(args => args.includes("fetch")).every(args => args.includes("--filter=tree:0")));
            assert.ok(commands.filter(args => args.includes("ls-tree")).every(args => !args.includes("-r")));
            await assert.rejects(access(temporary), { code: "ENOENT" });
        }
    } finally { await removeTemporary(source); }
});

test("invalid revisions never run Git and failed fetches clean up their temporary repository", async () => {
    await assert.rejects(gitRevisionTrees(["main"], { run: () => assert.fail("invalid revision") }), /无效/);
    assert.equal((await gitRevisionTrees([], { run: () => assert.fail("no revisions") })).size, 0);
    let temporary;
    await assert.rejects(gitRevisionTrees(["a".repeat(40)], { run: async (_file, args) => {
        temporary = args[1];
        if (args.includes("fetch")) throw new Error("fixture network failure");
        return { stdout: "" };
    } }), /fixture network failure/);
    await assert.rejects(access(temporary), { code: "ENOENT" });
});

async function versionFixture(t) {
    const source = await mkdtemp(join(tmpdir(), "opencode-version-regression-"));
    t.after(() => removeTemporary(source));
    const git = async args => (await exec("git", ["-C", source, ...args], { windowsHide: true })).stdout.trim();
    const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false"];
    const commit = async () => {
        await git(["add", "."]);
        await git([...identity, "commit", "-qm", "fixture"]);
        return git(["rev-parse", "HEAD"]);
    };
    await git(["init", "--quiet", "--initial-branch=main"]);
    await git(["config", "uploadpack.allowFilter", "true"]);
    await git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
    for (const id of ["opencode-providers", "opencode-ui"]) {
        await mkdir(join(source, "plugins", id), { recursive: true });
        await writeFile(join(source, "plugins", id, "index.js"), "export default 1;\n");
    }
    const old = await commit();
    await writeFile(join(source, "README.md"), "Unrelated fixture change\n");
    const unchanged = await commit();
    await writeFile(join(source, "plugins", "opencode-providers", "index.js"), "export default 2;\n");
    const latest = await commit();
    const run = (file, args, options) => exec(file, args.map(arg => arg === repo ? pathToFileURL(source).href : arg), options);
    return { git, identity, run, old, unchanged, latest };
}

const rateLimited = async () => { throw new Error("API rate limit fixture"); };
const config = (kind, id, ref) => ({ kind, data: { plugins: [specifier(id, ref)] } });

test("one unavailable commit does not block valid plugin updates during API rate limiting", async t => {
    const { run, old, latest } = await versionFixture(t);
    const missing = "f".repeat(40);
    const configs = [config("server", "opencode-providers", old), config("tui", "opencode-ui", missing)];
    const trees = await loadVersionTrees(configs, latest, "", rateLimited, {
        readGitTrees: (refs, options) => gitRevisionTrees(refs, { ...options, run }),
    });
    assert.equal(trees.get(missing), undefined);
    const items = statuses(configs, latest, "", trees);
    assert.equal(items.find(p => p.id === "opencode-providers").state, "update");
    assert.equal(items.find(p => p.id === "opencode-ui").state, "unknown");
});

test("one unavailable root tree does not discard other plugin version results", async t => {
    const { git, run, old, unchanged, latest } = await versionFixture(t);
    const deniedRoot = await git(["rev-parse", `${unchanged}^{tree}`]);
    const configs = [config("server", "opencode-providers", old), config("tui", "opencode-ui", unchanged)];
    const trees = await loadVersionTrees(configs, latest, "", rateLimited, {
        readGitTrees: (refs, options) => gitRevisionTrees(refs, { ...options, run: (file, args, settings) => {
            if (args.includes("fetch") && args.includes(deniedRoot)) throw new Error("fixture unavailable tree");
            return run(file, args, settings);
        } }),
    });
    assert.equal(trees.get(unchanged), undefined);
    const items = statuses(configs, latest, "", trees);
    assert.equal(items.find(p => p.id === "opencode-providers").state, "update");
    assert.equal(items.find(p => p.id === "opencode-ui").state, "unknown");
});

test("cached short IDs resolve tag-only commits, peel annotated tags and reject moved tag targets", async t => {
    const { git, identity, run, old, latest } = await versionFixture(t);
    const root = await git(["rev-parse", `${old}^{tree}`]);
    const tagged = await git([...identity, "commit-tree", root, "-m", "tag-only fixture"]);
    await git([...identity, "tag", "release", tagged]);
    await git([...identity, "tag", "-a", "annotated-release", tagged, "-m", "fixture annotation"]);
    await git([...identity, "tag", "moved", latest]);
    await git(["branch", "release", latest]);
    const blob = await git(["rev-parse", `${old}:plugins/opencode-providers/index.js`]);
    await git([...identity, "tag", "document-tag", blob]);
    const short = tagged.slice(0, 7);
    for (const ref of ["release", "refs/tags/annotated-release", "moved"]) {
        const source = specifier("opencode-providers", ref);
        const configs = [{ kind: "server", data: { plugins: [{ package: source, options: {} }] } }, config("tui", "opencode-ui", old)];
        const installed = `- ${short} ${source}`;
        let types;
        const trees = await loadVersionTrees(configs, latest, installed, rateLimited, {
            readGitTrees: (refs, options) => gitRevisionTrees(refs, { ...options, run: async (file, args, settings) => {
                const result = await run(file, args, settings);
                if (args.includes("ls-tree")) types = (await exec(file, ["-C", args[1], "cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"], settings)).stdout.trim().split(/\s+/);
                return result;
            } }),
        });
        const items = statuses(configs, latest, installed, trees);
        assert.equal(items.find(p => p.id === "opencode-providers").state, ref === "moved" ? "unknown" : "update");
        assert.equal(items.find(p => p.id === "opencode-ui").state, "current");
        assert.ok(types.every(type => type === "commit" || type === "tree"), "tag discovery must not download documents or annotations");
    }
});
