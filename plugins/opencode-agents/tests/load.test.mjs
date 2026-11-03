import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgents, parseAgent, registerAgents } from "../src/load.js";

test("plain Markdown and v2 frontmatter become agent definitions", () => {
    assert.equal(parseAgent("Test prompt", "review.md").id, "bundled-review");
    const agent = parseAgent("---\nname: demo\nmode: subagent\nmodel: krill/gpt-6.1-sol\npermissions:\n  - action: edit\n    resource: '*'\n    effect: deny\n---\nTest only", "x.md");
    assert.equal(agent.system, "Test only");
    assert.equal(agent.mode, "subagent");
    assert.equal(agent.model.providerID, "krill");
    assert.equal(agent.permissions.at(-1).effect, "deny");
});

test("dotted filenames and explicit names preserve localized agent identities", () => {
    for (const name of ["ratman4080.zh", "review.zh-CN", "review.v2.zh_CN", "审查.中文"]) {
        for (const agent of [
            parseAgent("Synthetic localized prompt", `${name}.md`),
            parseAgent(`---\nname: ${name}\n---\nSynthetic localized prompt`, "fixture.md"),
        ]) {
            assert.equal(agent.id, `bundled-${name}`);
            assert.equal(agent.name, `bundled-${name}`);
        }
    }
});

test("agent names still reject empty segments, paths and whitespace", () => {
    for (const name of ["", ".review", "review.", "review..zh", "../review", "review/zh", "review\\zh", "review zh"]) {
        assert.throws(() => parseAgent(`---\nname: '${name}'\n---\nSynthetic prompt`, "fixture.md"), /invalid agent name/);
    }
});

test("errors do not disclose document contents", () => {
    for (const source of ["---\nname: [secret-marker\n---\nTest", "---\nmode: secret-marker\n---\nTest", "---\npermission: secret-marker\n---\nTest", ""]) {
        assert.throws(() => parseAgent(source, "test.md"), error => !error.message.includes("secret-marker"));
    }
});

test("only fixture Markdown is loaded and duplicate names fail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-agent-fixture-"));
    try {
        await writeFile(join(dir, "one.md"), "Fixture prompt");
        await writeFile(join(dir, "one.zh.md"), "Synthetic localized prompt");
        await writeFile(join(dir, "one-zh.md"), "Synthetic separate prompt");
        await writeFile(join(dir, "ignored.txt"), "ignored");
        await mkdir(join(dir, "nested"));
        await writeFile(join(dir, "nested", "ignored.md"), "ignored");
        const agents = await loadAgents(dir);
        assert.deepEqual(agents.map(agent => agent.id).sort(), ["bundled-one", "bundled-one-zh", "bundled-one.zh"].sort());
        await writeFile(join(dir, "two.md"), "---\nname: one\n---\nOther fixture");
        await assert.rejects(loadAgents(dir), /duplicate/);
        await writeFile(join(dir, "two.md"), "---\nname: ONE.ZH\n---\nOther fixture");
        await assert.rejects(loadAgents(dir), /duplicate/);
        assert.deepEqual(await loadAgents(join(dir, "missing")), []);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("registration leaves existing agents untouched", () => {
    const agents = [parseAgent("fixture", "existing.md"), parseAgent("fixture", "new.md")];
    const result = new Map([["bundled-existing", { system: "untouched" }]]);
    registerAgents({ get: id => result.has(id), update: (id, fn) => { const value = {}; fn(value); result.set(id, value); } }, agents);
    assert.equal(result.get("bundled-existing").system, "untouched");
    assert.equal(result.get("bundled-new").system, "fixture");
});
