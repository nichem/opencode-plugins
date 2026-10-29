import { Plugin } from "@opencode/plugin";
import { SearchRPC } from "./src/rpc.js";
import { SearchService, SelectionError } from "./src/service.js";
import { wrapSearch } from "./src/tool.js";
import { ConfigurationError } from "./src/config.js";
import { DSS_ID, DSS_NAME } from "./src/deepseek.js";

export default Plugin.define({
    id: "opencode-websearch",
    async setup(ctx) {
        await ctx.integration.transform(editor => {
            editor.update(DSS_ID, integration => { integration.name = `${DSS_NAME} (DeepSeek Search)`; });
            editor.method.update({ integrationID: DSS_ID, method: { type: "key", label: "DeepSeek Search API Key" } });
        });
        const service = new SearchService(ctx);
        await service.initialize();
        await ctx.websearch.transform(editor => service.transform(editor));
        await ctx.tool.transform(editor => editor.update("websearch", tool => {
            tool.execute = wrapSearch(service, tool.execute);
        }));
        const registration = await ctx.rpc.register(SearchRPC, {
            state: async ({ sessionID, sources }, context) => {
                try { return await service.state(sessionID, sources); } catch (error) {
                    if (error instanceof SelectionError || error instanceof ConfigurationError) return context.error("selection", error.message, {});
                    throw error;
                }
            },
            select: async (input, context) => {
                try { return await service.select(input); } catch (error) {
                    if (error instanceof SelectionError || error instanceof ConfigurationError) return context.error("selection", error.message, {});
                    throw error;
                }
            },
        });
        const controller = new AbortController();
        const watch = (async () => {
            try {
                for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                    if (["credential.updated", "credential.switched", "integration.updated"].includes(event.type))
                        await service.refreshConnection();
                }
            } catch {
                // The picker also refreshes readiness; never log connection payloads.
            }
        })();
        return async () => { controller.abort(); await registration.dispose(); await watch; };
    },
});
