import { Plugin } from "@opencode/plugin";
import * as Tool from "@opencode/plugin/promise/tool";
import { SkillsRPC } from "./src/rpc.js";
import { SkillsService, credential } from "./src/service.js";
import { skills, skillIDs, skillDescription, skillDocument } from "./src/catalog.js";
import { callAPI, APIError } from "./src/api.js";

const schema = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const skillField = { type: "string", enum: skillIDs };

export default Plugin.define({
    id: "opencode-deepseek-skills",
    async setup(ctx) {
        const registrations = [];
        const service = new SkillsService(ctx);
        const permit = context => (action, resource) => ctx.permission.assert({
            sessionID: context.sessionID, agent: context.agent, action, resources: [resource],
            source: { type: "tool", messageID: context.messageID, id: context.id },
        });
        // Rethrow native permission rejection unchanged so it can stop the current step.
        const guarded = work => async (input, context) => {
            try { await service.assertEnabled(context.sessionID, input.skill); }
            catch (error) { throw new Tool.Error({ message: error.message }); }
            return work(input, context);
        };
        try {
            registrations.push(await ctx.integration.transform(editor => {
                editor.update("dss", entry => { entry.name = "DSS (DeepSeek Skills)"; });
                editor.method.update({ integrationID: "dss", method: { type: "key", label: "DeepSeek API Key" } });
            }));
            registrations.push(await ctx.tool.transform(editor => {
                editor.add({ name: "deepseek_skill", description: skillDescription, options: { codemode: false, permission: "skill" },
                    input: schema({ skill: skillField }), execute: guarded(async ({ skill }, context) => {
                        await permit(context)("skill", `deepseek-${skill}`);
                        const document = await skillDocument(skill);
                        await service.loaded(context.sessionID, skill);
                        return { content: document, metadata: { title: `DeepSeek ${skills.find(item => item.id === skill).name}` } };
                    }) });
                editor.add({ name: "deepseek_run", description: "执行已通过 deepseek_skill 加载的 DeepSeek 技能。input 参数见对应 SKILL.md。",
                    options: { codemode: false }, input: schema({ skill: skillField, input: { type: "object", additionalProperties: true } }),
                    execute: guarded(async ({ skill, input }, context) => {
                        try { await service.assertEnabled(context.sessionID, skill, true); }
                        catch (error) { throw new Tool.Error({ message: error.message }); }
                        const key = await credential(ctx.integration);
                        if (!key) throw new Tool.Error({ message: "请通过 /connect 连接 DSS (DeepSeek Skills)" });
                        const permission = permit(context);
                        try {
                            const value = await callAPI(skill, input, { key, signal: context.signal,
                                directory: ctx.location.directory, permit: async (action, resource) => {
                                    await permission(action, resource);
                                    await service.assertEnabled(context.sessionID, skill, true);
                                } });
                            return { content: JSON.stringify(value), metadata: { title: `DeepSeek ${skill.toUpperCase()}` } };
                        } catch (error) {
                            if (error instanceof APIError) throw new Tool.Error({ message: error.message });
                            throw error;
                        }
                    }) });
            }));
            for (const name of ["context", "generate", "compaction"])
                registrations.push(await ctx.session.hook(name, event => service.context(event)));
            registrations.push(await ctx.rpc.register(SkillsRPC, {
                state: ({ sessionID }) => service.state(sessionID),
                toggle: ({ sessionID }) => service.toggle(sessionID),
                create: ({ model }) => service.create(model),
            }));
        } catch (error) {
            await Promise.allSettled(registrations.reverse().map(item => item.dispose()));
            throw error;
        }
        return async () => { for (const item of registrations.reverse()) await item.dispose(); };
    },
});
