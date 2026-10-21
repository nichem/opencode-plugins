import { test } from "bun:test";
import assert from "node:assert/strict";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { testRender, useRenderer } from "@opentui/solid";
import { BoxRenderable, ScrollBoxRenderable, SyntaxStyle, TextRenderable, Yoga } from "@opentui/core";
import { findBlocks, ThinkingAdapter } from "../src/adapter.js";
import plugin from "../tui.js";

// Artificial content, with the conditional sibling structure of native v2.1.2
// Spinner, InlineToolRow, GroupAnchor and ReasoningPart. Compile through Solid
// so its invisible layout/text slots are present in the actual renderer tree.
function Spinner(props: { animations: boolean }) {
    return <Show when={props.animations} fallback={<text>⋯ Thinking: Fixture</text>}>
        <box flexDirection="row" gap={1} flexShrink={1}>
            <box flexShrink={0}><text>⠋</text></box>
            <Show when={true}><text>Thinking: Fixture</text></Show>
        </box>
    </Show>;
}

function Row(props: { running: boolean; expanded: boolean; animations: boolean; toggle: () => void }) {
    return <box paddingLeft={3} onMouseUp={props.toggle}>
        <Switch>
            <Match when={props.running}>
                <Show when={false} fallback={<Spinner animations={props.animations} />}>{() => null}</Show>
            </Match>
            <Match when={true}>
                <box flexDirection="row">
                    <text width={2}>{props.expanded ? "-" : "+"}</text>
                    <text flexGrow={1}>Thought · 2 steps · 2s</text>
                </box>
            </Match>
        </Switch>
        <Show when={false}><box><text>Artificial tool error</text></box></Show>
    </box>;
}

async function fixture({ grouped = true, animations = true, expanded = false, running = true, lines = 5,
    rowID = "msg_fixture", width = 80 } = {}) {
    const [state, setState] = createSignal({ expanded, running, animations });
    let anchor!: BoxRenderable, scroll!: ScrollBoxRenderable, composer!: BoxRenderable, style!: SyntaxStyle;
    let toggles = 0;
    const toggle = () => { toggles++; setState(value => ({ ...value, expanded: !value.expanded })); };
    const content = Array.from({ length: lines }, (_, index) => `Artificial thought line ${index + 1}`).join("\n");
    function Body() {
        return <box paddingLeft={1}><code content={content} syntaxStyle={style} drawUnstyledText={true} /></box>;
    }
    const screen = await testRender(() => {
        style = SyntaxStyle.fromStyles({ default: { fg: "#999999" } }, useRenderer().nativeScene);
        return <box flexDirection="column" height={16}>
          <box flexGrow={1} minHeight={0} position="relative" height={14}>
           <scrollbox ref={node => scroll = node} width="100%" height="100%" flexGrow={1} stickyStart="bottom">
            <box id={rowID} flexShrink={0}>
                <Show when={grouped} fallback={
                    <box ref={node => anchor = node} paddingLeft={3} flexDirection="column" flexShrink={0}>
                        <box border={["left"]} paddingLeft={1}>
                            <box onMouseUp={() => {}}>
                                <Switch>
                                    <Match when={state().running}><box flexDirection="row"><Spinner animations={state().animations} /></box></Match>
                                    <Match when={true}><text>Thought: 2s</text></Match>
                                </Switch>
                            </box>
                        </box>
                        <Show when={true}><box marginTop={1}><Body /></box></Show>
                    </box>
                }>
                    <box ref={node => anchor = node} flexDirection="column" flexShrink={0}>
                        <Show when={true}>
                            <Row running={state().running} expanded={state().expanded} animations={state().animations} toggle={toggle} />
                            <Show when={state().expanded}><box paddingLeft={3}><Body /></box></Show>
                        </Show>
                        <Show when={true}><For each={[]}>{() => null}</For></Show>
                    </box>
                </Show>
            </box>
           </scrollbox>
          </box>
          <box height={1} flexShrink={0} />
          <box ref={node => composer = node} flexShrink={0} />
        </box>;
    }, { width, height: 16 });
    const ctx = { renderer: screen.renderer, theme: { text: { muted: "#999999" } } };
    const adapter = new ThinkingAdapter(ctx as any);
    const blocks = () => findBlocks(screen.renderer.root, new Set(["msg_fixture"]));
    const update = (duration = 2000) => adapter.update(blocks(), { group: duration, part: duration }, true, true);
    await screen.renderOnce();
    return { ...screen, ctx, adapter, anchor, scroll, composer, state, setState, blocks, update, toggles: () => toggles,
        async close() { adapter.dispose(); await screen.dispose(); style.destroy(); } };
}

test("native Solid slots do not hide a thinking group, and its footer collapses a long body", async () => {
    const s = await fixture({ expanded: true, lines: 60 });
    try {
        assert.ok(s.anchor.getChildren()[0].getChildren().some(node => !node.visible), "the native header includes a real Solid placeholder");
        assert.equal(s.blocks().length, 1);
        s.update(); await s.renderOnce();
        assert.match(s.captureCharFrame(), /Thinking: Fixture\s+· 2s/);
        s.scroll.scrollTo(s.scroll.scrollHeight); await s.renderOnce();
        assert.match(s.captureCharFrame(), /收起思考/);
        const footer = s.anchor.getChildren().find(node => node.id === "opencode-ui:collapse")!;
        await s.mockMouse.click(footer.x + 1, footer.y);
        s.update(); await s.renderOnce();
        assert.equal(s.toggles(), 1);
        assert.equal(s.state().expanded, false);
        assert.match(s.captureCharFrame(), /Thinking: Fixture/);
        assert.doesNotMatch(s.captureCharFrame(), /收起思考|Artificial thought line/);
    } finally { await s.close(); }
});

// Mount a contribution at the fixture's actual composer boundary, preserving
// the reactive slot input used when the host reuses a session view.
function startPlugin(s: Awaited<ReturnType<typeof fixture>>, messages: any[], status: "idle" | "running" = "running") {
    const route = { type: "session", sessionID: "fixture" };
    const slotInput = { sessionID: "fixture" };
    const notices: any[] = [];
    let marker: BoxRenderable | undefined;
    const cleanup = plugin.setup({ ...s.ctx, app: { version: "2.1.2" }, options: {},
        data: { session: { status: () => status, message: { list: () => messages } } },
        ui: { router: { current: () => route }, toast: { show: (notice: any) => notices.push(notice) },
            slot(claim: any) {
                marker = claim.render(slotInput);
                s.composer.add(marker);
                return () => marker?.destroyRecursively();
            } },
        keymap: { layer() {} },
    } as any) as () => void;
    return { cleanup, notices, route, slotInput, marker: () => marker };
}

function messagesAt(now: number, id = "msg_fixture", elapsed = 2000) {
    return [{ id, type: "assistant", time: { created: now - elapsed }, content: [
        { type: "reasoning", text: "Current artificial thought", time: { created: now - elapsed } },
    ] }];
}

test("initial anonymous groups keep a timer and collapse footer without any message boundary row", async () => {
    const s = await fixture({ rowID: "native-anonymous-group", expanded: true, lines: 60 });
    const running = startPlugin(s, messagesAt(Date.now()));
    try {
        await s.renderOnce();
        assert.equal(running.notices.length, 0);
        assert.match(s.captureCharFrame(), /Thinking: Fixture\s+· 2s/);
        assert.equal(running.marker()?.getComputedLayout().height, 0);
        s.scroll.scrollTo(s.scroll.scrollHeight); await s.renderOnce();
        assert.match(s.captureCharFrame(), /收起思考/);
        const footer = s.anchor.getChildren().find(node => node.id === "opencode-ui:collapse")!;
        await s.mockMouse.click(footer.x + 4, footer.y);
        await new Promise(resolve => setTimeout(resolve, 280));
        await s.renderOnce();
        assert.equal(s.toggles(), 1);
        assert.equal(s.state().expanded, false);
        assert.doesNotMatch(s.captureCharFrame(), /收起思考/);
    } finally { running.cleanup(); await s.close(); }
});

test("removing a mounted message boundary does not remove enhancements from its anonymous group", async () => {
    const s = await fixture({ rowID: "native-anonymous-group", expanded: true });
    const boundary = new BoxRenderable(s.renderer, { id: "msg_fixture", height: 0 });
    s.scroll.add(boundary, 0);
    const running = startPlugin(s, messagesAt(Date.now()));
    try {
        await s.renderOnce();
        assert.match(s.captureCharFrame(), /· 2s/);
        boundary.destroyRecursively();
        await new Promise(resolve => setTimeout(resolve, 280));
        await s.renderOnce();
        assert.match(s.captureCharFrame(), /· 2s/);
        assert.match(s.captureCharFrame(), /收起思考/);
    } finally { running.cleanup(); await s.close(); }
});

test("anonymous transcript ownership follows the slot session and is cleared across routes", async () => {
    const s = await fixture({ rowID: "native-anonymous-group", expanded: true });
    const messages = messagesAt(Date.now());
    const running = startPlugin(s, messages);
    try {
        await s.renderOnce();
        assert.match(s.captureCharFrame(), /· 2s/);
        running.route.sessionID = "other-session";
        messages.splice(0, messages.length, ...messagesAt(Date.now(), "msg_other", 4000));
        await new Promise(resolve => setTimeout(resolve, 280));
        await s.renderOnce();
        assert.doesNotMatch(s.captureCharFrame(), /· [24]s|收起思考/);
        // The host now reuses the same view for the newly selected session.
        running.slotInput.sessionID = "other-session";
        await new Promise(resolve => setTimeout(resolve, 280));
        await s.renderOnce();
        assert.match(s.captureCharFrame(), /· 4s/);
        assert.match(s.captureCharFrame(), /收起思考/);
        running.route.type = "home";
        await new Promise(resolve => setTimeout(resolve, 280));
        await s.renderOnce();
        assert.doesNotMatch(s.captureCharFrame(), /· [24]s|收起思考/);
    } finally { running.cleanup(); await s.close(); }
});

test("the composer marker isolates its timeline from another panel with the same message ID", async () => {
    const s = await fixture({ expanded: true });
    const panel = new ScrollBoxRenderable(s.renderer, { width: "100%", height: 3, stickyStart: "bottom" });
    s.renderer.root.add(panel);
    const row = new BoxRenderable(s.renderer, { id: "msg_fixture" });
    panel.add(row);
    const anchor = new BoxRenderable(s.renderer, {});
    row.add(anchor);
    const header = new BoxRenderable(s.renderer, { paddingLeft: 3 });
    anchor.add(header);
    const line = new BoxRenderable(s.renderer, { flexDirection: "row" });
    header.add(line);
    line.add(new TextRenderable(s.renderer, { content: "Thinking: Other panel" }));
    await s.renderOnce();
    assert.equal(findBlocks(s.renderer.root, new Set(["msg_fixture"])).length, 2);
    const running = startPlugin(s, messagesAt(Date.now()));
    const marker = running.marker();
    try {
        await s.renderOnce();
        assert.match(s.captureCharFrame(), /Thinking: Fixture\s+· 2s/);
        assert.ok(!line.getChildren().some(node => node.id.startsWith("opencode-ui:")));
    } finally {
        running.cleanup();
        assert.ok(marker?.isDestroyed);
        assert.equal(marker?.parent, null);
        await s.close();
    }
});

test("group timer continues across hidden synthetic context in the actual TUI setup", async () => {
    const s = await fixture({ expanded: true });
    const now = Date.now();
    const messages: any[] = [
        { id: "msg_before", type: "assistant", time: { created: now - 6000, completed: now - 3000 }, finish: "unknown",
            content: [{ type: "reasoning", text: "Earlier artificial thought", time: { created: now - 6000, completed: now - 3000 } }] },
        { id: "msg_hidden", type: "synthetic", text: "Artificial hidden context", time: { created: now - 2500 } },
        ...messagesAt(now),
    ];
    const running = startPlugin(s, messages);
    try {
        await s.renderOnce();
        assert.match(s.captureCharFrame(), /Thinking: Fixture\s+· 5s/);
        assert.doesNotMatch(s.captureCharFrame(), /· 2s/);
    } finally { running.cleanup(); await s.close(); }
});

test("animations disabled keeps the live seconds on the same line and restores the host layout", async () => {
    const s = await fixture({ animations: false, expanded: true });
    try {
        assert.equal(s.blocks().length, 1);
        const header = s.blocks()[0].header;
        const direction = header.getFlexDirection();
        s.update(); await s.renderOnce();
        assert.match(s.captureCharFrame(), /⋯ Thinking: Fixture\s+· 2s/);
        assert.match(s.captureCharFrame(), /收起思考/);
        s.update(3000); await s.renderOnce();
        assert.match(s.captureCharFrame(), /· 3s/);
        s.adapter.dispose(); await s.renderOnce();
        assert.equal(header.getFlexDirection(), direction);
        assert.doesNotMatch(s.captureCharFrame(), /· 3s|收起思考/);
    } finally { await s.close(); }
});

test("changing animation settings and finishing thinking retain native controls without duplicate clocks", async () => {
    const s = await fixture({ expanded: true });
    try {
        for (const animations of [true, false, true, false]) {
            s.setState(value => ({ ...value, animations }));
            await s.renderOnce();
            s.update(); await s.renderOnce();
            assert.equal((s.captureCharFrame().match(/· 2s/g) ?? []).length, 1);
            assert.equal(s.anchor.getChildren().filter(node => node.id === "opencode-ui:collapse").length, 1);
        }
        s.setState(value => ({ ...value, running: false }));
        await s.renderOnce();
        s.update(); await s.renderOnce();
        assert.match(s.captureCharFrame(), /Thought · 2 steps · 2s/);
        assert.equal(s.blocks()[0].header.getFlexDirection(), Yoga.FlexDirection.Column);
        assert.match(s.captureCharFrame(), /收起思考/);
    } finally { await s.close(); }
});

test("the actual TUI setup counts only the current individual thought", async () => {
    for (const animations of [true, false]) {
        const s = await fixture({ grouped: false, animations });
        let cleanup: (() => void) | undefined;
        try {
            const now = Date.now();
            const messages = [{ id: "msg_fixture", type: "assistant", time: { created: now - 6000 }, content: [
                { type: "reasoning", text: "Earlier artificial thought", time: { created: now - 6000, completed: now - 3000 } },
                { type: "reasoning", text: "Current artificial thought", time: { created: now - 2000 } },
            ] }];
            cleanup = startPlugin(s, messages).cleanup;
            await s.renderOnce();
            assert.match(s.captureCharFrame(), /Thinking: Fixture\s+· 2s/);
            assert.doesNotMatch(s.captureCharFrame(), /· 5s|收起思考/);
        } finally { cleanup?.(); await s.close(); }
    }
});
