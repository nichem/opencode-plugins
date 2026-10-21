import test from "node:test";
import assert from "node:assert/strict";
import { createEffect } from "solid-js";
import { testRender } from "@opentui/solid";
import { jsx } from "@opentui/solid/jsx-runtime";
import { PickerView } from "../src/dialog.js";

const state = { defaultProvider: "random", enabled: true, providers: [
    { id: "exa", name: "Exa", available: true }, { id: "dss", name: "DSS", available: false },
] };
async function render(sessionID, value = state) {
    let commands = [];
    const selected = [], notices = [];
    const ctx = {
        theme: { text: { base: "#ffffff", muted: "#aaaaaa", action: { primary: { base: "#ffffff" } } },
            background: { raised: { base: "#202020" }, action: { primary: { base: "#405080" } } } },
        keymap: { layer: factory => { createEffect(() => { commands = factory().commands; }); } },
        ui: { toast: { show: notice => { notices.push(notice); } } },
    };
    const screen = await testRender(() => jsx(PickerView, { ctx, state: value, sessionID, done: choice => { selected.push(choice); } }),
        { width: 80, height: 24 });
    await screen.renderOnce();
    return { ...screen, selected, notices, commands: () => commands };
}
test("the rendered session shortcut appears only on a connected concrete provider", async () => {
    const screen = await render("A");
    try {
        assert.doesNotMatch(screen.captureCharFrame(), /s 仅当前会话/);
        assert.ok(!screen.commands().some(command => command.bind === "s"));
        screen.mockInput.pressArrow("down");
        await screen.renderOnce();
        assert.match(screen.captureCharFrame(), /s 仅当前会话/);
        const action = screen.commands().find(command => command.bind === "s");
        assert.ok(action);
        action.run();
        assert.deepEqual(screen.selected.at(-1), { providerID: "exa", scope: "session" });
        screen.mockInput.pressArrow("down");
        await screen.renderOnce();
        assert.doesNotMatch(screen.captureCharFrame(), /s 仅当前会话/);
        assert.ok(!screen.commands().some(command => command.bind === "s"));
        screen.commands().find(command => command.bind === "return").run();
        assert.equal(screen.notices.at(-1).variant, "info");
        screen.mockInput.pressArrow("up");
        screen.mockInput.pressArrow("up");
        await screen.renderOnce();
        assert.doesNotMatch(screen.captureCharFrame(), /s 仅当前会话/);
        screen.commands().find(command => command.bind === "return").run();
        assert.deepEqual(screen.selected.at(-1), { providerID: "random", scope: "default" });
    } finally { await screen.dispose(); }
});
test("the rendered home dialog never shows s, even after highlighting a provider", async () => {
    const screen = await render();
    try {
        screen.mockInput.pressArrow("down");
        await screen.renderOnce();
        assert.doesNotMatch(screen.captureCharFrame(), /s 仅当前会话/);
        assert.ok(!screen.commands().some(command => command.bind === "s"));
    } finally { await screen.dispose(); }
});

test("effective disabled search hides s on a connected provider", async () => {
    const screen = await render("A", { ...state, enabled: false, defaultProvider: "exa" });
    try {
        assert.match(screen.captureCharFrame(), /搜索已禁用/);
        assert.doesNotMatch(screen.captureCharFrame(), /s 仅当前会话/);
        assert.ok(!screen.commands().some(command => command.bind === "s"));
    } finally { await screen.dispose(); }
});
