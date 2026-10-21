import { findBlocks, supportedVersions, supports, ThinkingAdapter } from "./src/adapter.js";
import { liveDuration } from "./src/duration.js";
import { trackTranscript } from "./src/transcript.js";

/** @type {import('@opencode/plugin/tui').Plugin.Definition} */
export default {
    id: "opencode-ui.tui",
    setup(ctx) {
        const compatible = supports(ctx.app.version);
        const adapter = new ThinkingAdapter(ctx);
        let matched = 0;
        let failed = false;
        /** @type {ReturnType<typeof trackTranscript> | undefined} */
        let transcript;
        const update = () => {
            if (failed || ctx.renderer.isDestroyed) return;
            try {
                const route = ctx.ui.router.current();
                if (route.type !== "session") {
                    adapter.dispose();
                    matched = 0;
                    return;
                }
                const messages = ctx.data.session.message.list(route.sessionID);
                const blocks = findBlocks(ctx.renderer.root, new Set(messages.map(message => message.id)), transcript?.current(route.sessionID));
                matched = blocks.length;
                const status = ctx.data.session.status(route.sessionID), now = Date.now();
                adapter.update(blocks, { group: liveDuration(messages, status, now), part: liveDuration(messages, status, now, "part") },
                    ctx.options.thinkingTimer !== false, ctx.options.collapseThinking !== false);
            } catch {
                failed = true;
                adapter.dispose();
                transcript?.dispose();
                transcript = undefined;
                ctx.ui.toast.show({ variant: "warning", message: "UI 增强已停止：思考区块结构不兼容，请更新插件。" });
            }
        };
        ctx.keymap.layer(() => ({ mode: "global", commands: [{ id: "ui.status", title: "查看 UI 增强状态", group: "UI",
            palette: true, slash: { name: "ui-enhance-status" }, run() {
                ctx.ui.toast.show({ variant: compatible && !failed ? "info" : "warning",
                    message: !compatible ? `UI 增强暂不支持 OpenCode ${ctx.app.version}，当前适配 ${supportedVersions.join("、")}。`
                        : failed ? "UI 增强已因结构不兼容停止，请更新插件。"
                        : `UI 增强已启用，当前识别到 ${matched} 个思考区块。` });
            } }] }));
        if (!compatible) {
            ctx.ui.toast.show({ variant: "warning", message: `UI 增强暂不支持 OpenCode ${ctx.app.version}，当前适配 ${supportedVersions.join("、")}。` });
            return;
        }
        transcript = trackTranscript(ctx);
        update();
        const interval = setInterval(update, 250);
        return () => { clearInterval(interval); adapter.dispose(); transcript?.dispose(); };
    },
};
