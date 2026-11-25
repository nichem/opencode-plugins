import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { confirm } from "@inquirer/prompts";
import { managePlugins } from "../manage-prompt.js";
import { createSelection } from "../selection.js";

const latest = "a".repeat(40);
const items = [
    { id: "installed", title: "人工更新项", state: "update", label: "有更新" },
    { id: "absent", title: "人工未安装项", state: "absent", label: "未安装" },
    { id: "current", title: "人工最新版项", state: "current", label: "最新" },
];

async function render(t, prompt = managePlugins, config = { rows: createSelection(items, latest) }) {
    const input = new PassThrough(), output = new PassThrough();
    output.columns = 180;
    const controller = new AbortController();
    let screen = "";
    output.on("data", data => { screen += data.toString(); });
    const result = prompt(config, { input, output, signal: controller.signal });
    // Inquirer defers initial rendering to discard input left by the previous prompt.
    await setImmediate();
    t.after(async () => { controller.abort(); await result.catch(() => {}); input.destroy(); output.destroy(); });
    return {
        result,
        screen: () => stripVTControlCharacters(screen),
        press: async key => { input.write(key); await setImmediate(); },
    };
}

test("Enter on initial management screen performs no action", async t => {
    const ui = await render(t);
    assert.match(ui.screen(), /\[x\] installed/);
    assert.match(ui.screen(), /\[ \] absent/);
    assert.match(ui.screen(), /保持勾选不会自动更新/);
    await ui.press("\r");
    assert.deepEqual(await ui.result, []);
});

test("real u, arrows and space keys produce separate update, install and remove actions", async t => {
    const ui = await render(t);
    await ui.press("u");
    assert.match(ui.screen(), /待更新/);
    await ui.press("\u001b[B");
    await ui.press(" ");
    await ui.press("\u001b[B");
    await ui.press(" ");
    await ui.press("\r");
    assert.deepEqual((await ui.result).map(({ plugin, action }) => [plugin.id, action]),
        [["installed", "update"], ["absent", "install"], ["current", "remove"]]);
});

test("u twice cancels an update; unchecking and rechecking also clears it", async t => {
    for (const keys of [["u", "u"], ["u", " ", "u", " "]]) {
        const ui = await render(t);
        for (const key of keys) await ui.press(key);
        await ui.press("\r");
        assert.deepEqual(await ui.result, []);
    }
});

test("Esc discards pending operations and Ctrl+C still exits the prompt", async t => {
    const back = await render(t);
    await back.press("u");
    await back.press("\u001b");
    assert.equal(await back.result, undefined);
    const exit = await render(t);
    const rejected = assert.rejects(exit.result, { name: "ExitPromptError" });
    await exit.press("\u0003");
    await rejected;
});

test("real confirmation defaults to no on Enter and accepts an explicit yes", async t => {
    for (const [key, expected] of [["\r", false], ["y\r", true]]) {
        const ui = await render(t, confirm, { message: "确认执行变更？", default: false });
        await ui.press(key);
        assert.equal(await ui.result, expected);
    }
});
