import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { DSS_ID, DSS_QUERY_ERROR, isQueryValidationFailure, validateQuery } from "./deepseek.js";

export function searchResult(response) {
    return {
        output: { provider: response.providerID, results: response.results },
        content: [{ type: "text", text: response.results.length ? response.results.map(result =>
            `## [${result.title || result.url}](${result.url})${result.content ? `\n\n${result.content}` : ""}`).join("\n\n") : "未找到搜索结果。" }],
        metadata: { provider: response.providerID },
    };
}

export function wrapSearch(service, native) {
    return async (input, context) => {
        const providerID = await service.ctx.storage.get(service.sessionKey(context.sessionID));
        if (typeof providerID !== "string") {
            try { return await native(input, context); }
            catch (error) {
                if (!context.signal.aborted && isQueryValidationFailure(error))
                    throw new ToolError({ message: DSS_QUERY_ERROR, metadata: { provider: DSS_ID } });
                throw error;
            }
        }
        context.signal.throwIfAborted();
        await service.ctx.permission.assert({
            sessionID: context.sessionID, agent: context.agent, action: "websearch", resources: [input.query], save: ["*"],
            source: { type: "tool", messageID: context.messageID, id: context.id },
        });
        context.signal.throwIfAborted();
        if (providerID === DSS_ID) {
            try { validateQuery(input.query); }
            catch { throw new ToolError({ message: DSS_QUERY_ERROR, metadata: { provider: DSS_ID } }); }
        }
        await context.progress({ provider: providerID });
        try {
            const { data } = await service.ctx.websearch.query({ query: input.query, providerID }, { signal: context.signal });
            return searchResult(data);
        } catch (error) {
            if (context.signal.aborted) throw error;
            throw new ToolError({ message: "搜索失败，请检查供应商连接后重试" });
        }
    };
}
