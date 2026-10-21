import { BoxRenderable, ScrollBoxRenderable, Yoga } from "@opentui/core";

/** @param {import('@opentui/core').BaseRenderable} node
 * @param {import('@opentui/core').Renderable} root */
function mounted(node, root) {
    /** @type {import('@opentui/core').BaseRenderable | null} */
    let current = node;
    for (; current; current = current.parent) {
        if (!current.visible) return false;
        if (current === root) return true;
    }
    return false;
}

/** Locate the v2.1.2 timeline wrapper preceding the composer, without using row IDs.
 * @param {BoxRenderable} marker
 * @returns {ScrollBoxRenderable | undefined} */
function precedingTranscript(marker) {
    for (let branch = /** @type {import('@opentui/core').BaseRenderable} */ (marker); branch.parent; branch = branch.parent) {
        const siblings = branch.parent.getChildren();
        const index = siblings.indexOf(branch);
        if (index === -1) return;
        const before = siblings.slice(0, index);
        const matches = before.filter(node => node.visible && node instanceof BoxRenderable
            && node.getFlexGrow() === 1 && node.getMinHeight().value === 0
            && node.getPositionType() === Yoga.PositionType.Relative)
            .flatMap(node => node.getChildren().filter(child => child.visible))
            .filter(node => node instanceof ScrollBoxRenderable && node.stickyStart === "bottom" && node.getFlexGrow() === 1);
        if (matches.length) return matches.length === 1 ? /** @type {ScrollBoxRenderable} */ (matches[0]) : undefined;
    }
}

/**
 * The public composer slot supplies session identity even when all mounted
 * transcript rows are anonymous. A zero-size marker changes no host content.
 * @param {import('@opencode/plugin/tui').Plugin.Context} ctx
 */
export function trackTranscript(ctx) {
    /** @type {Set<{ node: BoxRenderable, sessionID: () => string }>} */
    const markers = new Set();
    /** @type {import('@opencode/plugin/tui/context').SlotClaim<'session.composer.top'>} */
    const claim = {
        before: "session.composer.top",
        render(input) {
            const node = new BoxRenderable(ctx.renderer, { id: "opencode-ui:transcript-anchor", width: 0, height: 0, flexShrink: 0 });
            // Keep reading the live slot input: the host may reuse this view
            // when navigating to another session without remounting the slot.
            const marker = { node, sessionID: () => input.sessionID };
            markers.add(marker);
            node.on("destroyed", () => markers.delete(marker));
            // OpenTUI's universal renderer mounts these nodes as JSX elements.
            return /** @type {import('@opentui/solid').JSX.Element} */ (/** @type {unknown} */ (node));
        },
    };
    const stop = ctx.ui.slot(claim);
    return {
        /** @param {string} sessionID */
        current(sessionID) {
            /** @type {Set<ScrollBoxRenderable>} */
            const matches = new Set();
            for (const marker of markers) {
                if (marker.node.isDestroyed || marker.sessionID() !== sessionID || !mounted(marker.node, ctx.renderer.root)) continue;
                const scroll = precedingTranscript(marker.node);
                if (scroll) matches.add(scroll);
            }
            return matches.size === 1 ? matches.values().next().value : undefined;
        },
        dispose() { stop(); markers.clear(); },
    };
}
