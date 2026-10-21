import { BoxRenderable, CodeRenderable, MouseEvent, ScrollBoxRenderable, TextRenderable, Yoga } from "@opentui/core";
import { formatDuration } from "./duration.js";

export const supportedVersions = ["2.1.2"];
const prefix = "opencode-ui:";

/** @param {string} version */
export function supports(version) {
    return supportedVersions.includes(version.replace(/^v/, ""));
}

/** @param {import('@opentui/core').BaseRenderable} node */
function children(node) {
    // Solid's conditional siblings leave invisible LayoutSlotRenderable nodes.
    // They do not contribute to the visible header/body shape.
    return node.getChildren().filter(child => child.visible && !child.id.startsWith(prefix));
}

/** @param {import('@opentui/core').BaseRenderable} node
 * @returns {import('@opentui/core').BaseRenderable[]} */
function descendants(node) {
    return children(node).flatMap(child => [child, ...descendants(child)]);
}

/** @param {import('@opentui/core').BaseRenderable} node */
function hasCode(node) {
    return descendants(node).some(child => child instanceof CodeRenderable);
}

/** @param {import('@opentui/core').BaseRenderable} node
 * @param {number} depth
 * @returns {TextRenderable[]} */
function label(node, depth = 3) {
    // Header text only: never inspect code, tool output or reasoning bodies.
    if (node instanceof TextRenderable) return [node];
    if (!(node instanceof BoxRenderable) || depth === 0) return [];
    return children(node).flatMap(child => label(child, depth - 1));
}

/** Spinner's static fallback prefixes the label when animations are disabled.
 * @param {TextRenderable} text */
function headerText(text) {
    return text.plainText.replace(/^⋯ /, "");
}

/** @typedef {{ anchor: BoxRenderable, header: BoxRenderable, title: TextRenderable,
 * clockParent: BoxRenderable, scroll: ScrollBoxRenderable, running: boolean, expanded: boolean, grouped: boolean }} ThinkingBlock */

/** @typedef {{ clock?: TextRenderable, footer?: BoxRenderable, inlineParent?: BoxRenderable }} Attachment */

/** @param {Attachment} state */
function clearClock(state) {
    state.clock?.destroy();
    state.clock = undefined;
    const parent = state.inlineParent;
    if (parent && !parent.isDestroyed && parent.getFlexDirection() === Yoga.FlexDirection.Row) parent.flexDirection = "column";
    state.inlineParent = undefined;
}

/**
 * Version-specific adapter for upstream group-view.tsx and message-parts.tsx.
 * Match complete header shapes, inside the current transcript's scrollbox.
 * No host prototypes, handlers, text or disclosure state are overwritten.
 * @param {import('@opentui/core').Renderable} root
 * @param {Set<string>} messageIDs
 * @param {ScrollBoxRenderable} [transcript] Session-owned timeline resolved from the public composer slot.
 * @returns {ThinkingBlock[]}
 */
export function findBlocks(root, messageIDs, transcript) {
    /** @type {ThinkingBlock[]} */
    const result = [];
    const scrolls = transcript ? [transcript] : [root, ...descendants(root)].filter(node => node instanceof ScrollBoxRenderable);
    for (const scroll of scrolls) {
        if (!(scroll instanceof ScrollBoxRenderable)) continue;
        const rows = children(scroll.content);
        if (!transcript && !rows.some(row => messageIDs.has(row.id.startsWith("session-part:") ? row.id.split(":")[1] : row.id))) continue;
        for (const node of rows.flatMap(row => [row, ...descendants(row)])) {
            if (!(node instanceof BoxRenderable)) continue;
            const [first, body, ...extra] = children(node);
            if (!(first instanceof BoxRenderable) || extra.length || (body && !(body instanceof BoxRenderable))) continue;

            // GroupAnchor -> InlineToolRow (paddingLeft=3) -> row -> title.
            const [row, ...other] = children(first);
            if (first.getPadding(Yoga.Edge.Left).value === 3 && other.length === 0
                && (row instanceof TextRenderable || (row instanceof BoxRenderable && row.getFlexDirection() === Yoga.FlexDirection.Row))) {
                const texts = label(row);
                const title = texts.find(text => /^(?:Thinking(?::|$)|Thought(?:[: ·]|$))/.test(headerText(text)));
                const icon = texts[0]?.plainText;
                const running = title ? headerText(title).startsWith("Thinking") : false;
                if (title && title.parent instanceof BoxRenderable && (running || icon === "+" || icon === "-")) {
                    const expanded = !!body && hasCode(body);
                    if (!body || expanded) {
                        result.push({ anchor: node, header: first, title, clockParent: title.parent, scroll, running, expanded, grouped: true });
                        continue;
                    }
                }
            }

            // ReasoningPart -> bordered header -> clickable box -> header.
            if (node.getPadding(Yoga.Edge.Left).value !== 3) continue;
            if (first.getFlexDirection() !== Yoga.FlexDirection.Column) continue;
            const [clickable, ...siblings] = children(first);
            if (!(clickable instanceof BoxRenderable) || siblings.length) continue;
            const texts = label(clickable);
            const title = texts.find(text => /^(?:Thinking(?::|$)|[+-] Thought(?:[: ]|$))/.test(headerText(text)));
            if (!title || !(title.parent instanceof BoxRenderable)) continue;
            const running = headerText(title).startsWith("Thinking");
            if (body && !hasCode(body)) continue;
            result.push({ anchor: node, header: clickable, title, clockParent: title.parent, scroll, running, grouped: false,
                expanded: !!body && (title.plainText.startsWith("- ") || (running
                    && children(body)[0] instanceof BoxRenderable
                    && /** @type {BoxRenderable} */ (children(body)[0]).getPadding(Yoga.Edge.Left).value === 3)) });
        }
    }
    // A nested wrapper must not make the same header count twice.
    return result.filter((block, index) => result.findIndex(item => item.header === block.header) === index);
}

export class ThinkingAdapter {
    /** @param {import('@opencode/plugin/tui').Plugin.Context} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        /** @type {Map<BoxRenderable, Attachment>} */
        this.attached = new Map();
    }

    /** @param {ThinkingBlock[]} blocks
     * @param {{ group?: number, part?: number }} durations
     * @param {boolean} timer
     * @param {boolean} collapse */
    update(blocks, durations, timer, collapse) {
        const active = blocks.filter(block => block.running);
        const seen = new Set(blocks.map(block => block.header));
        for (const [header, state] of this.attached) {
            if (seen.has(header) && !header.isDestroyed) continue;
            clearClock(state);
            state.footer?.destroyRecursively();
            this.attached.delete(header);
        }
        for (const block of blocks) {
            let state = this.attached.get(block.header);
            if (!state) this.attached.set(block.header, state = {});
            if (state.clock?.isDestroyed) clearClock(state);
            if (state.footer?.isDestroyed) state.footer = undefined;
            const duration = block.grouped ? durations.group : durations.part;
            if (timer && duration !== undefined && block.running && active.length === 1) {
                if (!state.clock || state.clock.parent !== block.clockParent) {
                    clearClock(state);
                    // With animations disabled, Spinner returns a text directly
                    // inside the column header. Keep its additive timer inline,
                    // and restore this one header's layout when it is removed.
                    if (block.clockParent.getFlexDirection() === Yoga.FlexDirection.Column) {
                        state.inlineParent = block.clockParent;
                        block.clockParent.flexDirection = "row";
                    }
                    state.clock = new TextRenderable(this.ctx.renderer, { id: `${prefix}clock`, flexShrink: 0, selectable: false, wrapMode: "none" });
                    block.clockParent.add(state.clock);
                }
                const text = ` · ${formatDuration(duration)}`;
                if (state.clock.plainText !== text) state.clock.content = text;
                state.clock.fg = this.ctx.theme.text.muted;
            } else {
                clearClock(state);
            }
            if (collapse && block.expanded) {
                if (!state.footer) {
                    state.footer = new BoxRenderable(this.ctx.renderer, { id: `${prefix}collapse`, paddingLeft: 3, flexShrink: 0,
                        onMouseUp: event => this.collapse(block, event) });
                    state.footer.add(new TextRenderable(this.ctx.renderer, { content: "↑ 收起思考", selectable: false, fg: this.ctx.theme.text.muted }));
                    block.anchor.add(state.footer);
                }
                // Solid can replace the body while keeping the header mounted.
                // Keep our unmanaged footer after the new host-owned content.
                if (block.anchor.getChildren().at(-1) !== state.footer) {
                    block.anchor.remove(state.footer);
                    block.anchor.add(state.footer);
                }
                const text = state.footer.getChildren()[0];
                if (text instanceof TextRenderable) text.fg = this.ctx.theme.text.muted;
            } else {
                state.footer?.destroyRecursively();
                state.footer = undefined;
            }
        }
    }

    /** @param {ThinkingBlock} block
     * @param {MouseEvent} event */
    collapse(block, event) {
        event.stopPropagation();
        if (event.button !== 0 || event.isDragging || this.ctx.renderer.getSelection()?.getSelectedText() || block.header.isDestroyed) return;
        // Recheck: the host may have collapsed/remounted the block since the last scan.
        const current = findBlocks(block.scroll, new Set(), block.scroll)
            .find(item => item.header === block.header);
        if (!current?.expanded) return;
        const offset = block.header.y - block.scroll.viewport.y;
        if (offset < 0) block.scroll.scrollBy({ x: 0, y: offset });
        const click = new MouseEvent(block.header, { type: "up", button: 0, x: block.header.x, y: block.header.y,
            modifiers: { shift: false, alt: false, ctrl: false } });
        click.stopPropagation();
        block.header.processMouseEvent(click);
    }

    dispose() {
        for (const state of this.attached.values()) {
            clearClock(state);
            state.footer?.destroyRecursively();
        }
        this.attached.clear();
    }
}
