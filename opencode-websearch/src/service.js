import { DSS_ID, DSS_NAME, deepseekCredential, SearchError, searchDeepSeek } from "./deepseek.js";
import { ProjectConfiguration } from "./config.js";
import { resolve } from "node:path";

export class SelectionError extends Error {}

export class SearchService {
    constructor(ctx, { transport = (...args) => globalThis.fetch(...args), configuration = new ProjectConfiguration(ctx.location.directory) } = {}) {
        this.ctx = ctx;
        this.transport = transport;
        this.configuration = configuration;
        this.connected = false;
        this.pending = Promise.resolve();
    }

    sessionKey(sessionID) { return `session/${sessionID}`; }

    async initialize() {
        this.connected = Boolean(await deepseekCredential(this.ctx.integration));
    }

    transform(editor) {
        if (this.connected) editor.add({
            id: DSS_ID, name: DSS_NAME,
            execute: async ({ query }, { signal }) => {
                const key = await deepseekCredential(this.ctx.integration);
                if (!key) throw new SearchError("请先通过 /connect 连接 DeepSeek，再使用 DSS");
                return searchDeepSeek(query, key, signal, this.transport);
            },
        });
        // Read after the registry has finished replaying every transform, so a
        // later plugin's default is included in the same registry generation.
        this.readNativeDefault = () => editor.default.get();
    }

    async refreshConnection() {
        if (this.connectionWork) return this.connectionWork;
        const work = this.updateConnection();
        this.connectionWork = work;
        try { await work; } finally { this.connectionWork = undefined; }
    }

    async updateConnection() {
        const connected = Boolean(await deepseekCredential(this.ctx.integration));
        if (connected === this.connected) return;
        const previous = this.connected;
        this.connected = connected;
        try { await this.ctx.websearch.reload(); } catch (error) { this.connected = previous; throw error; }
    }

    async state(sessionID, sources) {
        if (sessionID) await this.assertSessionLocation(sessionID);
        await this.refreshConnection();
        const { data } = await this.ctx.websearch.providers();
        const configured = await this.configuration.read(sources);
        const selection = configured ?? this.readNativeDefault?.();
        const defaultProvider = typeof selection === "string" ? selection : "random";
        const enabled = selection !== false;
        const providers = data.map(({ id, name }) => ({ id, name, available: true }));
        if (!providers.some(item => item.id === DSS_ID)) providers.push({ id: DSS_ID, name: DSS_NAME, available: false });
        const sessionProvider = sessionID ? await this.ctx.storage.get(this.sessionKey(sessionID)) : undefined;
        return { defaultProvider, enabled, providers,
            ...(typeof sessionProvider === "string" ? { sessionProvider } : {}) };
    }

    async assertSessionLocation(sessionID) {
        const data = await this.ctx.session.get({ sessionID });
        const normalize = directory => process.platform === "win32" ? resolve(directory).toLowerCase() : resolve(directory);
        if (!data?.location?.directory || normalize(data.location.directory) !== normalize(this.ctx.location.directory))
            throw new SelectionError("会话位置已变化，请重新打开 /search 后重试");
    }

    select(input) {
        const result = this.pending.then(() => this.apply(input));
        this.pending = result.catch(() => {});
        return result;
    }

    async apply({ providerID, scope, sessionID, sources }) {
        const state = await this.state(sessionID, sources);
        if (providerID !== "random" && !state.providers.some(item => item.id === providerID && item.available))
            throw new SelectionError(providerID === DSS_ID ? "请先通过 /connect 连接 DeepSeek" : "该搜索供应商当前不可用，请重新选择");
        if (sessionID) await this.assertSessionLocation(sessionID);
        if (scope === "session") {
            if (!sessionID) throw new SelectionError("请先打开一个会话");
            if (providerID === "random") throw new SelectionError("random 仅支持保存为默认选择，请选择具体供应商后按 s");
            if (!state.enabled) throw new SelectionError("搜索已禁用，请先按 Enter 保存默认选择以启用搜索");
            await this.ctx.storage.set(this.sessionKey(sessionID), providerID);
        } else {
            const previous = sessionID ? await this.ctx.storage.get(this.sessionKey(sessionID)) : undefined;
            if (sessionID) await this.ctx.storage.remove(this.sessionKey(sessionID));
            try {
                await this.configuration.write(providerID, sources);
            } catch (error) {
                if (sessionID && previous !== undefined) await this.ctx.storage.set(this.sessionKey(sessionID), previous);
                throw error;
            }
            const { sessionProvider, ...result } = state;
            return { ...result, defaultProvider: providerID, enabled: true, reloadRequired: true };
        }
        return this.state(sessionID, sources);
    }

}
