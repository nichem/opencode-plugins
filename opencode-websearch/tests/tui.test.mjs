import test from "node:test";
import assert from "node:assert/strict";
import { installPicker, PickerModel, searchConfiguration } from "../src/picker.js";

const state = { defaultProvider: "random", enabled: true, providers: [
    { id: "exa", name: "Exa", available: true }, { id: "dss", name: "DSS", available: false },
] };
test("only ordered search fields are passed from the native configuration API", async () => {
    const location = { directory: "/fixture/project" };
    const client = { config: { get: async (input, options) => {
        assert.deepEqual(input, { location });
        assert.ok(options.signal instanceof AbortSignal);
        return [{ type: "document", path: "/fixture/global/opencode.json", info: { websearch: false, privateValue: "fixture-only" } },
            { type: "directory", path: "/fixture/project/.opencode" },
            { type: "document", path: "/fixture/project/opencode.json", info: { plugins: ["other"] } },
            { type: "document", info: { websearch: { provider: "exa", privateValue: "fixture-only" } } }];
    } } };
    assert.deepEqual(await searchConfiguration(client, location), [
        { path: "/fixture/global/opencode.json", websearch: false }, { websearch: { provider: "exa" } },
    ]);
});
test("s is hidden for home, random, unavailable providers, and disabled search", () => {
    const home = new PickerModel(state);
    home.index = 1;
    assert.equal(home.canSession, false);
    const session = new PickerModel(state, "A");
    assert.equal(session.selected.id, "random");
    assert.equal(session.canSession, false);
    assert.equal(session.choice("session"), undefined);
    session.index = 1;
    assert.equal(session.canSession, true);
    assert.deepEqual(session.choice("session"), { providerID: "exa", scope: "session" });
    session.index = 2;
    assert.equal(session.canSession, false);
    assert.equal(session.choice("default"), undefined);
    const disabled = new PickerModel({ ...state, enabled: false, defaultProvider: "exa" }, "A");
    assert.equal(disabled.canSession, false);
});
test("saved choices are highlighted and random always stays first", () => {
    const model = new PickerModel({ ...state, sessionProvider: "exa" }, "A");
    assert.equal(model.selected.id, "exa");
    assert.equal(model.options[0].id, "random");
    assert.deepEqual(model.choice("default"), { providerID: "exa", scope: "default" });
});

async function picker({ route = { type: "home" }, choose = async () => undefined,
    save = async input => ({ ...state, ...(input.scope === "default" ? { defaultProvider: input.providerID } : { sessionProvider: input.providerID }) }),
    reload = async () => {}, sessionLocation = { directory: "/fixture/project" }, cachedSessionLocation = sessionLocation, lookup = async () => {} } = {}) {
    let command;
    let current = state;
    const selected = [], toasts = [], reloads = [], locations = [], sessionLookups = [];
    const ctx = {
        location: { directory: "/fixture/project" },
        data: { session: { get: () => ({ location: cachedSessionLocation }) } },
        client: {
            config: { get: async () => [] },
            session: { get: async input => { sessionLookups.push(input); await lookup(); return { location: sessionLocation }; } },
            rpc: () => ({ state: async (_input, options) => { locations.push(options.location); return current; },
                select: async (input, options) => { const { sources, ...choice } = input; selected.push(choice); locations.push(options.location); return current = await save(choice); } }),
            location: { reload: async options => { reloads.push(options); await reload(); } },
        },
        keymap: { layer: factory => { command = factory().commands[0]; } },
        ui: { router: { current: () => route }, toast: { show: value => { toasts.push(value); } } },
    };
    installPicker(ctx, choose);
    assert.equal(command.slash.name, "search");
    await command.run();
    return { selected, toasts, reloads, locations, sessionLookups };
}
test("home saving never creates a session and Enter uses the persistent scope", async () => {
    const result = await picker({ choose: async (_ctx, value, sessionID) => {
        assert.equal(value, state);
        assert.equal(sessionID, undefined);
        return { providerID: "exa", scope: "default" };
    } });
    assert.deepEqual(result.selected, [{ providerID: "exa", scope: "default" }]);
    assert.equal(result.sessionLookups.length, 0);
});
test("the active session location is fetched freshly and used for state, save, and post-reload verification", async () => {
    const location = { directory: "/fixture/other-project", workspaceID: "other-workspace" };
    const result = await picker({ route: { type: "session", sessionID: "B" }, sessionLocation: location,
        cachedSessionLocation: { directory: "/fixture/stale-project" },
        choose: async () => ({ providerID: "exa", scope: "default" }),
        save: async () => ({ ...state, defaultProvider: "exa", reloadRequired: true }) });
    assert.deepEqual(result.sessionLookups, [{ sessionID: "B" }]);
    assert.equal(result.locations.length, 3);
    for (const used of result.locations) assert.deepEqual(used, location);
    assert.equal(result.toasts.at(-1).variant, "success");
});
test("a failed session lookup never falls back to editing the TUI default project", async () => {
    let opened = false;
    const result = await picker({ route: { type: "session", sessionID: "B" }, lookup: async () => { throw new Error("Fixture missing session"); },
        choose: async () => { opened = true; return { providerID: "exa", scope: "default" }; } });
    assert.equal(opened, false);
    assert.deepEqual(result.selected, []);
    assert.equal(result.toasts.at(-1).variant, "error");
});
test("s binds only the session captured when opening the picker", async () => {
    const result = await picker({ route: { type: "session", sessionID: "A" },
        choose: async (_ctx, _state, sessionID) => { assert.equal(sessionID, "A"); return { providerID: "exa", scope: "session" }; } });
    assert.deepEqual(result.selected, [{ providerID: "exa", scope: "session", sessionID: "A" }]);
    assert.match(result.toasts.at(-1).message, /仅当前会话/);
    assert.equal(result.reloads.length, 0);
});
test("a saved project default refreshes OpenCode and a refresh failure reports that the save succeeded", async () => {
    const input = { choose: async () => ({ providerID: "exa", scope: "default" }),
        save: async () => ({ ...state, defaultProvider: "exa", reloadRequired: true }) };
    const success = await picker(input);
    assert.equal(success.reloads.length, 1);
    assert.ok(success.reloads[0].signal instanceof AbortSignal);
    assert.equal(success.toasts.at(-1).variant, "success");
    const failed = await picker({ ...input, reload: async () => { throw new Error("fixture refresh error"); } });
    assert.equal(failed.selected.length, 1);
    assert.equal(failed.toasts.at(-1).variant, "error");
    assert.match(failed.toasts.at(-1).message, /已保存.*刷新失败/);
    assert.doesNotMatch(JSON.stringify(failed.toasts), /fixture refresh/);
});
test("an overridden default never reports success after reloading", async () => {
    const result = await picker({ choose: async () => ({ providerID: "exa", scope: "default" }),
        save: async () => ({ ...state, reloadRequired: true }) });
    assert.equal(result.reloads.length, 1);
    assert.equal(result.toasts.at(-1).variant, "error");
    assert.match(result.toasts.at(-1).message, /已保存.*未生效/);
});
test("Escape performs no write; a save failure is observed without exposing upstream messages", async () => {
    assert.deepEqual((await picker()).selected, []);
    const result = await picker({ choose: async () => ({ providerID: "exa", scope: "default" }),
        save: async () => { throw new Error("fixture credential error"); } });
    assert.equal(result.selected.length, 1);
    assert.equal(result.toasts.at(-1).variant, "error");
    assert.doesNotMatch(JSON.stringify(result.toasts), /fixture credential/);
});
test("repeated invocations cannot open another picker during a save", async () => {
    let finish, command, opened = 0;
    const saving = new Promise(resolve => { finish = resolve; });
    const ctx = {
        location: { directory: "/fixture/project" },
        client: { config: { get: async () => [] }, rpc: () => ({ state: async () => state, select: () => saving }) },
        keymap: { layer: factory => { command = factory().commands[0]; } },
        ui: { router: { current: () => ({ type: "home" }) }, toast: { show() {} } },
    };
    installPicker(ctx, async () => { opened++; return { providerID: "exa", scope: "default" }; });
    const first = command.run();
    await new Promise(resolve => setImmediate(resolve));
    await command.run();
    assert.equal(opened, 1);
    finish({});
    await first;
});
