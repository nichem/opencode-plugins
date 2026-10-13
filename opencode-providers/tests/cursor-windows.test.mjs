import assert from "node:assert/strict";
import test from "node:test";
import { promisify } from "node:util";
import { cursorSandbox } from "./helpers/cursor-sandbox.mjs";
import * as upstream from "../src/providers/cursor/upstream.js";
import { fetchModels } from "../src/providers/cursor/vendor/protocol.js";

test("Cursor background Git and registry probes hide Windows consoles without changing results", async t => {
    const calls = [], root = "C:/virtual-fixture-repo";
    const replies = new Map([
        ["rev-parse --show-toplevel", root],
        ["remote -v", "origin https://example.invalid/fixture/repo.git (fetch)"],
        ["rev-parse --abbrev-ref HEAD", "fixture-branch"],
        ["status --porcelain -b", "## fixture-branch\n M fixture.txt"],
    ]);
    const execFile = () => assert.fail("Use the promisified fixture subprocess");
    execFile[promisify.custom] = async (command, args, options) => {
        calls.push({ command, args, options });
        assert.equal(command, "git");
        assert.equal(options.windowsHide, true);
        assert.equal(options.timeout, 5000);
        assert.equal(options.cwd, root);
        assert.ok(replies.has(args.join(" ")));
        return { stdout: replies.get(args.join(" ")), stderr: "" };
    };
    const execSync = (command, options) => {
        calls.push({ command, options });
        assert.match(command, /^reg query /);
        assert.equal(options.windowsHide, true);
        assert.equal(options.timeout, 5000);
        return Buffer.from("MachineGuid REG_SZ fixture-guid");
    };
    const h = await cursorSandbox(t, { modules: { "node:child_process": { execFile, execSync } } });
    const result = await h.api.fixtureCollectGit(root);
    assert.equal(result.gitRepos[0].branch_name, "fixture-branch");
    assert.equal(result.gitRepos[0].status, replies.get("status --porcelain -b"));
    assert.deepEqual(result.repositoryInfo[0].remote_urls, ["https://example.invalid/fixture/repo.git"]);
    assert.equal(h.api.fixtureWindowsMachineGuid(), "REG_SZfixture-guid");
    assert.equal(calls.length, 5);
});

test("Cursor probe failures retain their existing fallback behavior", async t => {
    const execFile = () => assert.fail("Use the promisified fixture subprocess");
    execFile[promisify.custom] = async () => { throw new Error("fixture git unavailable"); };
    const h = await cursorSandbox(t, { modules: { "node:child_process": {
        execFile, execSync: () => { throw new Error("fixture registry unavailable"); },
    } } });
    assert.deepEqual(await h.api.fixtureCollectGit("C:/virtual-fixture-repo"), { repositoryInfo: [], gitRepos: [] });
    assert.equal(h.api.fixtureWindowsMachineGuid(), undefined);
});

test("model discovery cannot bypass the patched subprocess helpers", () => {
    assert.equal(upstream.fetchModels, fetchModels);
});
