import test from "node:test";
import assert from "node:assert/strict";
import { installToggle } from "../src/toggle.js";

test("homepage saves enabled state before navigation and never submits a model prompt", async () => {
    const order = [];
    let command;
    const ctx = {
        keymap: { layer: factory => { command = factory().commands[0]; } },
        location: { directory: "/fixture" },
        client: { rpc: () => ({ create: async input => { order.push("saved"); assert.equal(input.model.id, "m");
            return { sessionID: "s", enabled: true, connected: true }; } }) },
        data: { session: { sync: async id => { assert.equal(id, "s"); order.push("sync"); } } },
        ui: { model: { current: () => ({ providerID: "p", modelID: "m" }) },
            router: { current: () => ({ type: "home" }), navigate: route => { order.push("navigate"); assert.equal(route.sessionID, "s"); } },
            toast: { show: value => { assert.equal(value.variant, "success"); } } },
    };
    installToggle(ctx);
    await command.run();
    assert.deepEqual(order, ["saved", "sync", "navigate"]);
});

test("existing sessions use their actual location and do not create another session", async () => {
    let command, toggled = 0;
    const ctx = { keymap: { layer: factory => { command = factory().commands[0]; } },
        client: { session: { get: async () => ({ location: { directory: "/actual" } }) },
            rpc: () => ({ toggle: async (input, options) => { assert.equal(input.sessionID, "s"); assert.equal(options.location.directory, "/actual");
                toggled++; return { enabled: false }; } }) },
        ui: { model: { current: () => undefined }, router: { current: () => ({ type: "session", sessionID: "s" }) }, toast: { show() {} } },
    };
    installToggle(ctx);
    await command.run();
    assert.equal(toggled, 1);
});
