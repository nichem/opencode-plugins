import { resolve } from "node:path";
import { isSkill, toolNames } from "./catalog.js";

export async function credential(integration) {
    const connection = await integration.connection.active("dss");
    if (connection?.type !== "credential") return;
    const value = await integration.connection.resolve(connection);
    if (value?.type === "key" && value.key.trim()) return value.key;
}

export class SkillsService {
    constructor(ctx) { this.ctx = ctx; this.queue = Promise.resolve(); }
    key(sessionID) { return `session/${sessionID}`; }
    async saved(sessionID) {
        const value = await this.ctx.storage.get(this.key(sessionID));
        return { enabled: value?.enabled === true, loaded: Array.isArray(value?.loaded) ? value.loaded.filter(isSkill) : [] };
    }
    async checkLocation(sessionID) {
        const session = await this.ctx.session.get({ sessionID });
        const normalize = value => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
        if (!session?.location?.directory || normalize(session.location.directory) !== normalize(this.ctx.location.directory))
            throw new Error("会话位置已变化，请重新执行 /deepseek-skills");
    }
    serial(work) {
        const result = this.queue.then(work);
        this.queue = result.catch(() => {});
        return result;
    }
    async state(sessionID) {
        await this.checkLocation(sessionID);
        return { sessionID, enabled: (await this.saved(sessionID)).enabled,
            connected: Boolean(await credential(this.ctx.integration).catch(() => undefined)) };
    }
    toggle(sessionID) {
        return this.serial(async () => {
            const state = await this.state(sessionID);
            await this.ctx.storage.set(this.key(sessionID), { enabled: !state.enabled, loaded: [] });
            return { ...state, enabled: !state.enabled };
        });
    }
    create(model) {
        return this.serial(async () => {
            const session = await this.ctx.session.create({ location: this.ctx.location,
                ...(model ? { model } : {}) });
            try {
                await this.ctx.storage.set(this.key(session.id), { enabled: true, loaded: [] });
            } catch {
                // The new session belongs to this command and has never been exposed to the TUI or prompted.
                await this.ctx.session.remove({ sessionID: session.id }).catch(() => {});
                throw new Error("技能状态保存失败，未开启会话");
            }
            return { sessionID: session.id, enabled: true, connected: Boolean(await credential(this.ctx.integration).catch(() => undefined)) };
        });
    }
    async assertEnabled(sessionID, skill, requireLoaded = false) {
        await this.checkLocation(sessionID);
        const state = await this.saved(sessionID);
        if (!state.enabled) throw new Error("当前会话未开启 DeepSeek 技能，请执行 /deepseek-skills");
        if (!isSkill(skill)) throw new Error("未知 DeepSeek 技能");
        if (requireLoaded && !state.loaded.includes(skill)) throw new Error(`请先通过 deepseek_skill 加载 ${skill} 技能`);
    }
    loaded(sessionID, skill) {
        return this.serial(async () => {
            await this.assertEnabled(sessionID, skill);
            const state = await this.saved(sessionID);
            await this.ctx.storage.set(this.key(sessionID), { ...state, loaded: [...new Set([...state.loaded, skill])] });
        });
    }
    async context(event) {
        const state = await this.saved(event.sessionID);
        if (!state.enabled) for (const name of toolNames) delete event.tools[name];
        else if (!state.loaded.length) delete event.tools.deepseek_run;
    }
}
