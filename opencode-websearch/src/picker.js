import { SearchRPC } from "./rpc.js";

export async function searchConfiguration(client, location) {
    const entries = await client.config.get({ location }, { signal: AbortSignal.timeout(15000) });
    return entries.flatMap(entry => {
        if (entry.type !== "document") return [];
        const websearch = entry.info.websearch;
        if (websearch !== false && typeof websearch?.provider !== "string") return [];
        return [{ ...(entry.path ? { path: entry.path } : {}),
            websearch: websearch === false ? false : { provider: websearch.provider } }];
    });
}

export class PickerModel {
    constructor(state, sessionID) {
        this.state = state;
        this.sessionID = sessionID;
        const current = state.sessionProvider ?? state.defaultProvider;
        this.options = [{ id: "random", name: "random", available: true }, ...state.providers.filter(provider => provider.id !== "random")];
        this.index = Math.max(0, this.options.findIndex(option => option.id === current && option.available));
    }
    get selected() { return this.options[this.index]; }
    get canSession() {
        return Boolean(this.sessionID && this.state.enabled && this.selected?.available && this.selected.id !== "random");
    }
    choice(scope) {
        if (!this.selected?.available || (scope === "session" && !this.canSession)) return;
        return { providerID: this.selected.id, scope };
    }
}

export function installPicker(ctx, show) {
    let opened = false;
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
        id: "websearch.select", title: "选择搜索供应商", group: "Search", palette: true,
        slash: { name: "search" },
        async run() {
            if (opened) return;
            opened = true;
            try {
                const route = ctx.ui.router.current();
                const sessionID = route.type === "session" ? route.sessionID : undefined;
                const session = sessionID ? await ctx.client.session.get({ sessionID }, { signal: AbortSignal.timeout(15000) }) : undefined;
                const location = sessionID ? session?.location && { directory: session.location.directory,
                    ...(session.location.workspaceID ? { workspaceID: session.location.workspaceID } : {}) }
                    : ctx.location ?? ctx.data.location.default();
                if (!location?.directory) throw new Error("Session location unavailable");
                const rpc = ctx.client.rpc(SearchRPC);
                const readState = async () => rpc.state({ ...(sessionID ? { sessionID } : {}), sources: await searchConfiguration(ctx.client, location) },
                    { location, signal: AbortSignal.timeout(15000) });
                const state = await readState();
                const choice = await show(ctx, state, sessionID);
                if (!choice) return;
                const result = await rpc.select({ ...choice, ...(sessionID ? { sessionID } : {}), sources: await searchConfiguration(ctx.client, location) },
                    { location, signal: AbortSignal.timeout(15000) });
                if (result.reloadRequired) {
                    try {
                        await ctx.client.location.reload({ signal: AbortSignal.timeout(15000) });
                        const applied = await readState();
                        if (!applied.enabled || applied.defaultProvider !== choice.providerID) {
                            ctx.ui.toast.show({ variant: "error", message: "默认搜索供应商已保存，但未生效；请检查优先级更高的配置" });
                            return;
                        }
                    }
                    catch {
                        ctx.ui.toast.show({ variant: "error", message: "默认搜索供应商已保存，但刷新失败；请执行 opencode reload" });
                        return;
                    }
                }
                ctx.ui.toast.show({ variant: "success", message: choice.scope === "session"
                    ? `搜索供应商：${choice.providerID}（仅当前会话）` : `默认搜索供应商：${choice.providerID}` });
            } catch {
                ctx.ui.toast.show({ variant: "error", message: "搜索供应商设置失败，请检查服务端插件状态和连接后重试" });
            } finally { opened = false; }
        },
    }] }));
}
