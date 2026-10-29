import { test } from "bun:test";
import assert from "node:assert/strict";
import { BoxRenderable, CodeRenderable, MouseEvent, ScrollBoxRenderable, SyntaxStyle, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { findBlocks, supports, ThinkingAdapter } from "../src/adapter.js";
import plugin from "../tui.js";

/** @param {import('@opentui/core').BaseRenderable} node
 * @returns {BoxRenderable[]} */
function collapseControls(node) {
    return node.getChildren().flatMap(child => child instanceof BoxRenderable && child.id === "opencode-ui:collapse"
        ? [child] : collapseControls(child));
}

// Artificial documents only. Shapes mirror the two native v2.1.2 components.
async function fixture({ running = true, expanded = false, individual = false, showMode = false, lines = 5, width = 80,
    rowID = "msg_fixture" } = {}) {
    const screen = await createTestRenderer({ width, height: 16 });
    const { renderer } = screen;
    const theme = { text: { muted: "#999999" } };
    const ctx = { renderer, theme };
    const adapter = new ThinkingAdapter(ctx);
    const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#999999" } }, renderer.nativeScene);
    const scroll = new ScrollBoxRenderable(renderer, { width: "100%", height: 14 });
    renderer.root.add(scroll);
    const row = new BoxRenderable(renderer, { id: rowID, flexShrink: 0 });
    scroll.add(row);
    const anchor = new BoxRenderable(renderer, { flexDirection: "column", flexShrink: 0, paddingLeft: individual ? 3 : 0 });
    row.add(anchor);
    const header = new BoxRenderable(renderer, { paddingLeft: individual ? 1 : 3 });
    anchor.add(header);
    const clickable = individual ? new BoxRenderable(renderer, {}) : header;
    if (individual) header.add(clickable);
    let isRunning = running, isExpanded = expanded, toggleCount = 0, body;
    function draw() {
        for (const child of clickable.getChildren()) child.destroyRecursively();
        if (isRunning) {
            const line = new BoxRenderable(renderer, { flexDirection: "row" });
            clickable.add(line);
            const spinner = new BoxRenderable(renderer, { flexDirection: "row", gap: 1 });
            line.add(spinner);
            const glyph = new BoxRenderable(renderer, {});
            glyph.add(new TextRenderable(renderer, { content: "⠋" }));
            spinner.add(glyph);
            spinner.add(new TextRenderable(renderer, { content: "Thinking: Fixture", fg: "#cccccc" }));
        } else if (individual) {
            clickable.add(new TextRenderable(renderer, { content: `${showMode ? "" : isExpanded ? "- " : "+ "}Thought: 2s` }));
        } else {
            const line = new BoxRenderable(renderer, { flexDirection: "row" });
            clickable.add(line);
            line.add(new TextRenderable(renderer, { content: isExpanded ? "-" : "+", width: 2 }));
            line.add(new TextRenderable(renderer, { content: "Thought · 2 steps · 2s", flexGrow: 1 }));
        }
        body?.destroyRecursively();
        body = undefined;
        if (isExpanded) {
            body = new BoxRenderable(renderer, { paddingLeft: individual ? 0 : 3, flexShrink: 0 });
            anchor.add(body);
            const border = new BoxRenderable(renderer, { paddingLeft: individual ? showMode ? 1 : 3 : 1 });
            body.add(border);
            border.add(new CodeRenderable(renderer, { content: Array.from({ length: lines }, (_, i) => `Artificial thought line ${i + 1}`).join("\n"),
                syntaxStyle, drawUnstyledText: true, streaming: false }));
        }
    }
    clickable.onMouseUp = () => { if (!showMode) { isExpanded = !isExpanded; toggleCount++; draw(); } };
    draw();
    const blocks = () => findBlocks(renderer.root, new Set(["msg_fixture"]));
    const update = (duration = 2000, timer = true, collapse = true) => adapter.update(blocks(), { group: duration, part: duration }, timer, collapse);
    return { ...screen, adapter, scroll, anchor, header: clickable, blocks, update,
        toggleCount: () => toggleCount, expanded: () => isExpanded,
        setRunning(value) { isRunning = value; draw(); },
        async close() { adapter.dispose(); await screen.dispose(); syntaxStyle.destroy(); } };
}

test("live seconds advance in the rendered title and disappear when native Thought replaces Thinking", async () => {
    const s = await fixture();
    try {
        assert.equal(s.blocks().length, 1, JSON.stringify(s.blocks().map(block => ({ anchor: block.anchor.id,
            header: block.header.id, title: block.title.plainText, flex: block.header.getFlexDirection() }))));
        s.update(2000); await s.renderOnce();
        assert.match(s.captureCharFrame(), /Thinking: Fixture\s+· 2s/);
        s.update(3000); await s.renderOnce();
        assert.match(s.captureCharFrame(), /· 3s/);
        s.update(3000); assert.equal(s.adapter.attached.size, 1);
        s.setRunning(false); s.update(undefined); await s.renderOnce();
        assert.match(s.captureCharFrame(), /Thought · 2 steps · 2s/);
        assert.doesNotMatch(s.captureCharFrame(), /· 3s/);
    } finally { await s.close(); }
});

test("the footer collapses the original block from the bottom of a long thought and can reopen", async () => {
    const s = await fixture({ expanded: true, running: false, lines: 60 });
    try {
        s.update(); await s.renderOnce();
        s.scroll.scrollTo(s.scroll.scrollHeight); await s.renderOnce();
        assert.match(s.captureCharFrame(), /收起思考/);
        const [footer] = collapseControls(s.anchor);
        await s.mockMouse.click(footer.x + 1, footer.y);
        s.update(); await s.renderOnce();
        assert.equal(s.expanded(), false);
        assert.equal(s.toggleCount(), 1);
        assert.match(s.captureCharFrame(), /Thought/);
        assert.doesNotMatch(s.captureCharFrame(), /收起思考|Artificial thought line/);
        await s.mockMouse.click(s.header.x + 3, s.header.y);
        s.update(); await s.renderOnce();
        assert.equal(s.expanded(), true);
        assert.equal(s.toggleCount(), 2);
        assert.equal(collapseControls(s.anchor).length, 1);
    } finally { await s.close(); }
});

test("individual reasoning has a live clock and its own collapse action", async () => {
    for (const running of [true, false]) {
        const s = await fixture({ expanded: true, individual: true, running });
        try {
            assert.equal(s.blocks().length, 1);
            s.update(); await s.renderOnce();
            assert.match(s.captureCharFrame(), /收起思考/);
            if (running) assert.match(s.captureCharFrame(), /· 2s/);
            const [footer] = collapseControls(s.anchor);
            await s.mockMouse.click(footer.x + 1, footer.y);
            s.update(); await s.renderOnce();
            assert.equal(s.expanded(), false);
        } finally { await s.close(); }
    }
});

test("a transcript containing only a session-part row still collapses from its footer", async () => {
    const s = await fixture({ expanded: true, running: false, rowID: "session-part:msg_fixture:reasoning:1" });
    try {
        s.update(); await s.renderOnce();
        const [footer] = collapseControls(s.anchor);
        assert.ok(footer);
        await s.mockMouse.click(footer.x + 1, footer.y);
        s.update(); await s.renderOnce();
        assert.equal(s.toggleCount(), 1);
        assert.equal(s.expanded(), false);
        assert.doesNotMatch(s.captureCharFrame(), /收起思考/);
    } finally { await s.close(); }
});

test("native show mode gets a timer without an ineffective collapse button", async () => {
    const s = await fixture({ expanded: true, individual: true, showMode: true });
    try {
        s.update(); await s.renderOnce();
        assert.match(s.captureCharFrame(), /· 2s/);
        assert.doesNotMatch(s.captureCharFrame(), /收起思考/);
    } finally { await s.close(); }
});

test("wrong-session and malformed headers are ignored; duplicate live headings suppress timing", async () => {
    const s = await fixture();
    try {
        assert.equal(findBlocks(s.renderer.root, new Set(["msg_other"])).length, 0);
        const [block] = s.blocks();
        s.adapter.update([block, { ...block, header: s.anchor }], { group: 2000, part: 2000 }, true, true);
        await s.renderOnce();
        assert.doesNotMatch(s.captureCharFrame(), /· 2s/);
        s.header.paddingLeft = 0;
        assert.equal(s.blocks().length, 0);
    } finally { await s.close(); }
});

test("options, selection guards and disposal leave the host content and click action intact", async () => {
    const s = await fixture({ expanded: true });
    try {
        s.update(2000, false, false); await s.renderOnce();
        assert.doesNotMatch(s.captureCharFrame(), /· 2s|收起思考/);
        s.update(); await s.renderOnce();
        const [block] = s.blocks();
        const event = new MouseEvent(block.header, { type: "up", button: 2, x: 0, y: 0, modifiers: { shift: false, alt: false, ctrl: false } });
        s.adapter.collapse(block, event);
        assert.equal(s.toggleCount(), 0);
        const original = s.renderer.getSelection;
        s.renderer.getSelection = () => ({ getSelectedText: () => "Fixture selection" });
        s.adapter.collapse(block, new MouseEvent(block.header, { type: "up", button: 0, x: 0, y: 0, modifiers: { shift: false, alt: false, ctrl: false } }));
        assert.equal(s.toggleCount(), 0);
        s.renderer.getSelection = original;
        s.adapter.dispose(); await s.renderOnce();
        assert.doesNotMatch(s.captureCharFrame(), /· 2s|收起思考/);
        assert.match(s.captureCharFrame(), /Artificial thought line/);
    } finally { await s.close(); }
});

test("narrow layouts preserve the seconds counter", async () => {
    const s = await fixture({ width: 32 });
    try { s.update(61000); await s.renderOnce(); assert.match(s.captureCharFrame(), /· 1m 1s/); }
    finally { await s.close(); }
});

test("all 2.x releases, including prereleases and build metadata, pass the version gate", () => {
    for (const version of ["2.0.0", "2.1.2", "2.1.3", "2.10.0", "v2.1.2", "2.2.0-beta.1", "v2.2.0-dev.1+build.42"])
        assert.ok(supports(version), version);
});

test("unsupported hosts register status only and never inspect the renderer tree", () => {
    for (const version of ["1.2.3", "3.0.0", "v3.0.0-beta.1", "12.1.2", "20.0.0", "unknown", ""]) {
        assert.ok(!supports(version), version);
        const notices = [], commands = [];
        plugin.setup({ app: { version }, keymap: { layer: factory => commands.push(...factory().commands) },
            ui: { toast: { show: notice => notices.push(notice) } }, get renderer() { throw new Error("Must not inspect unsupported UI"); } });
        assert.equal(notices.length, 1);
        commands[0].run();
        assert.equal(notices.at(-1).message, `UI 增强暂不支持 OpenCode ${version}，当前支持 2.x。`);
    }
});
