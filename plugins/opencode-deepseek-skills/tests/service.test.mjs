import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";
import { SkillsService, credential } from "../src/service.js";
import { toolNames } from "../src/catalog.js";

export function fixture() {
    const stored = new Map(), sessions = new Map(), tools = new Map(), hooks = new Map();
    const directory = process.cwd();
    let key = "fixture-key-1", id = 0;
    const ctx = {
        location: { directory },
        storage: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, value) },
        session: { get: async ({ sessionID }) => sessions.get(sessionID),
            create: async input => { const value = { ...input, id: `s${++id}` }; sessions.set(value.id, value); return value; },
            remove: async ({ sessionID }) => { sessions.delete(sessionID); },
            hook: async (name, fn) => { hooks.set(name, fn); return { dispose: async () => hooks.delete(name) }; } },
        integration: { connection: { active: async id => { assert.equal(id, "dss"); return key ? { type: "credential" } : undefined; },
            resolve: async () => ({ type: "key", key }) },
            transform: async fn => { fn({ update() {}, method: { update() {} } }); return { dispose: async () => {} }; } },
        tool: { transform: async fn => { fn({ add: tool => tools.set(tool.name, tool) }); return { dispose: async () => tools.clear() }; } },
        permission: { assert: async () => {} },
        rpc: { register: async () => ({ dispose: async () => {} }) },
    };
    return { ctx, stored, sessions, tools, hooks, service: new SkillsService(ctx), setKey: value => { key = value; } };
}

test("new sessions default off; toggles and loaded skills persist by session, not parent", async () => {
    const f = fixture();
    const first = await f.ctx.session.create({ location: f.ctx.location });
    const second = await f.ctx.session.create({ location: f.ctx.location, parentID: first.id });
    assert.equal((await f.service.state(first.id)).enabled, false);
    await f.service.toggle(first.id);
    await f.service.loaded(first.id, "search");
    assert.deepEqual(await new SkillsService(f.ctx).saved(first.id), { enabled: true, loaded: ["search"] });
    assert.equal((await f.service.state(second.id)).enabled, false);
    await f.service.toggle(first.id);
    await assert.rejects(f.service.assertEnabled(first.id, "search", true), /未开启/);
    await f.service.toggle(first.id);
    await assert.rejects(f.service.assertEnabled(first.id, "search", true), /先通过/);
});

test("homepage creates an enabled session before returning; storage failure removes only the new session", async () => {
    const f = fixture();
    const created = await f.service.create({ providerID: "fixture", id: "test" });
    assert.equal((await f.service.saved(created.sessionID)).enabled, true);
    assert.equal(f.sessions.get(created.sessionID).model.id, "test");
    f.ctx.storage.set = async () => { throw new Error("fixture failure"); };
    await assert.rejects(f.service.create(), /状态保存失败/);
    assert.deepEqual([...f.sessions.keys()], [created.sessionID]);
});

test("context removes only owned tools; execution also rejects stale or guessed calls while off", async () => {
    const f = fixture(), dispose = await plugin.setup(f.ctx);
    const session = await f.ctx.session.create({ location: f.ctx.location });
    const event = { sessionID: session.id, tools: Object.fromEntries([...toolNames, "read", "skill"].map(name => [name, {}])) };
    await f.hooks.get("context")(event);
    assert.deepEqual(Object.keys(event.tools), ["read", "skill"]);
    await assert.rejects(f.tools.get("deepseek_skill").execute({ skill: "search" }, { sessionID: session.id }), /未开启/);
    await f.service.toggle(session.id);
    await assert.rejects(f.tools.get("deepseek_run").execute({ skill: "search", input: { query: "x" } }, { sessionID: session.id }), /先通过/);
    await f.tools.get("deepseek_skill").execute({ skill: "search" }, { sessionID: session.id });
    const on = { sessionID: session.id, tools: { deepseek_skill: {}, deepseek_run: {}, read: {} } };
    await f.hooks.get("context")(on);
    assert.equal(Object.keys(on.tools).length, 3);
    assert.ok([...f.tools.values()].every(tool => tool.options.codemode === false));
    await dispose();
});

test("DSS uses the active credential only; disconnect and account switch take effect immediately", async () => {
    const f = fixture();
    assert.equal(await credential(f.ctx.integration), "fixture-key-1");
    f.setKey("fixture-key-2");
    assert.equal(await credential(f.ctx.integration), "fixture-key-2");
    f.setKey(undefined);
    assert.equal(await credential(f.ctx.integration), undefined);
});

test("rapid toggles serialize and moved sessions reject edits", async () => {
    const f = fixture(), state = await f.service.create();
    await Promise.all([f.service.toggle(state.sessionID), f.service.toggle(state.sessionID)]);
    assert.equal((await f.service.state(state.sessionID)).enabled, true);
    f.sessions.get(state.sessionID).location.directory += "/moved";
    f.ctx.location = { directory: process.cwd() };
    await assert.rejects(f.service.toggle(state.sessionID), /位置已变化/);
});
