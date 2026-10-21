import { findBlocks, supportedRange, supports, ThinkingAdapter } from "./src/adapter.js";
import { liveDuration } from "./src/duration.js";
import { trackTranscript } from "./src/transcript.js";

/** @type {import('@opencode/plugin/tui').Plugin.Definition} */
export default {
    id: "opencode-ui.tui",
    setup(ctx) {
        const compatible = supports(ctx.app.version);
        const adapter = new ThinkingAdapter(ctx);
        let matched = 0;
        /** @type {string | undefined} */
        let failure;
        /** @type {ReturnType<typeof setInterval> | undefined} */
        let interval;
        /** @type {ReturnType<typeof trackTranscript> | undefined} */
        let transcript;
        const update = () => {
            if (failure || ctx.renderer.isDestroyed) return;
            let stage = "读取会话";
            try {
                const route = ctx.ui.router.current();
                if (route.type !== "session") {
                    adapter.dispose();
                    matched = 0;
                    return;
                }
                const messages = ctx.data.session.message.list(route.sessionID);
                stage = "定位会话时间线";
                const scroll = transcript?.current(route.sessionID);
                stage = "识别思考区块";
                const blocks = findBlocks(ctx.renderer.root, new Set(messages.map(message => message.id)), scroll);
                matched = blocks.length;
                stage = "计算思考耗时";
                const status = ctx.data.session.status(route.sessionID), now = Date.now();
                const durations = { group: liveDuration(messages, status, now), part: liveDuration(messages, status, now, "part") };
                stage = "更新思考区块";
                adapter.update(blocks, durations, ctx.options.thinkingTimer !== false, ctx.options.collapseThinking !== false);
            } catch (error) {
                // Record only a fixed error category and our own phase. Exception
                // messages/stacks can include private transcript or config data.
                const kind = error instanceof Error && ["TypeError", "RangeError", "ReferenceError", "SyntaxError"].includes(error.name)
                    ? error.name : "Error";
                failure = `${stage} / ${kind}`;
                matched = 0;
                clearInterval(interval);
                adapter.dispose();
                transcript?.dispose();
                transcript = undefined;
                ctx.ui.toast.show({ variant: "warning", message: "UI 增强因运行异常已停止，输入 /ui-enhance-status 查看诊断。" });
            }
        };
        ctx.keymap.layer(() => ({ mode: "global", commands: [{ id: "ui.status", title: "查看 UI 增强状态", group: "UI",
            palette: true, slash: { name: "ui-enhance-status" }, run() {
                ctx.ui.toast.show({ variant: compatible && !failure ? "info" : "warning",
                    message: !compatible ? `UI 增强暂不支持 OpenCode ${ctx.app.version}，当前支持 ${supportedRange}。`
                        : failure ? `UI 增强因运行异常已停止（OpenCode ${ctx.app.version}；${failure}）。`
                        : `UI 增强已启用，当前识别到 ${matched} 个思考区块。` });
            } }] }));
        if (!compatible) {
            ctx.ui.toast.show({ variant: "warning", message: `UI 增强暂不支持 OpenCode ${ctx.app.version}，当前支持 ${supportedRange}。` });
            return;
        }
        transcript = trackTranscript(ctx);
        update();
        if (!failure) interval = setInterval(update, 250);
        return () => { clearInterval(interval); adapter.dispose(); transcript?.dispose(); };
    },
};
