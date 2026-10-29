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

test("errors do not disclose document contents", () => {
    for (const source of ["---\nname: [secret-marker\n---\nTest", "---\nmode: secret-marker\n---\nTest", "---\npermission: secret-marker\n---\nTest", ""]) {
        assert.throws(() => parseAgent(source, "test.md"), error => !error.message.includes("secret-marker"));
    }
});

test("only fixture Markdown is loaded and duplicate names fail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-agent-fixture-"));
    try {
        await writeFile(join(dir, "one.md"), "Fixture prompt");
        await writeFile(join(dir, "ignored.txt"), "ignored");
        await mkdir(join(dir, "nested"));
        await writeFile(join(dir, "nested", "ignored.md"), "ignored");
        const agents = await loadAgents(dir);
        assert.equal(agents.length, 1);
        await writeFile(join(dir, "two.md"), "---\nname: one\n---\nOther fixture");
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
