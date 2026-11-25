import { SkillsRPC } from "./rpc.js";

export function installToggle(ctx) {
    let busy = false;
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
        id: "deepseek-skills.toggle", title: "切换当前会话 DeepSeek 技能", group: "DeepSeek", palette: true,
        slash: { name: "deepseek-skills" },
        async run() {
            if (busy) return;
            busy = true;
            try {
                const route = ctx.ui.router.current();
                if (!["home", "session"].includes(route.type)) throw new Error("unsupported route");
                const session = route.type === "session" ? await ctx.client.session.get({ sessionID: route.sessionID }) : undefined;
                const location = session?.location ?? ctx.location ?? ctx.data.location.default();
                const rpc = ctx.client.rpc(SkillsRPC);
                // No timeout for mutations: a client timeout could leave a created session unacknowledged.
                const current = ctx.ui.model.current();
                const state = route.type === "session" ? await rpc.toggle({ sessionID: route.sessionID }, { location })
                    : await rpc.create({ ...(current ? { model: { providerID: current.providerID, id: current.modelID,
                        ...(current.variant ? { variant: current.variant } : {}) } } : {}) }, { location });
                if (route.type === "home") {
                    // The session is already saved. A refresh failure must not lose the created session.
                    await ctx.data.session.sync(state.sessionID).catch(() => {});
                    if (ctx.ui.router.current().type === "home") ctx.ui.router.navigate({ type: "session", sessionID: state.sessionID });
                }
                ctx.ui.toast.show({ variant: "success", sessionID: state.sessionID, message: `DeepSeek 技能已${state.enabled ? "开启" : "关闭"}（仅当前会话）`
                    + (state.enabled && !state.connected ? "；请通过 /connect 连接 DSS" : "") });
            } catch {
                ctx.ui.toast.show({ variant: "error", message: "DeepSeek 技能开关操作失败，请检查插件状态后重试" });
            } finally { busy = false; }
        },
    }] }));
}
