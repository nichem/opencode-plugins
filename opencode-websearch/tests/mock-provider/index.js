import { Plugin, Provider, Model } from "@opencode/plugin";
import { DSS_QUERY_ERROR, rateLimitError, SEARCH_URL } from "../../src/deepseek.js";

export function createMock() {
    return { languageModel: modelID => ({
        specificationVersion: "v3", provider: "websearch-fixture", modelId: modelID, supportedUrls: {},
        async doStream(options) {
            const retry = modelID === "length-retry" && options.prompt.at(-1)?.role === "tool"
                && JSON.stringify(options.prompt.at(-1)).includes(DSS_QUERY_ERROR);
            const complete = options.prompt.at(-1)?.role === "tool" && !retry;
            const query = !retry && ["long-query", "length-retry"].includes(modelID) ? "word ".repeat(30) : "offline fixture";
            const parts = [{ type: "stream-start", warnings: [] }];
            if (complete) parts.push({ type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "Fixture finished" }, { type: "text-end", id: "t" });
            else parts.push({ type: "tool-call", toolCallId: retry ? "search-retry" : "search", toolName: "websearch", input: JSON.stringify({ query }) });
            parts.push({ type: "finish", finishReason: { unified: complete ? "stop" : "tool-calls", raw: complete ? "stop" : "tool_calls" },
                usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
            return { stream: new ReadableStream({ start(controller) {
                for (const part of parts) controller.enqueue(part);
                controller.close();
            } }) };
        },
    }) };
}

export default Plugin.define({ id: "websearch-fixture", async setup(ctx) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
        const url = typeof input === "string" ? input : input.url ?? String(input);
        if (url === SEARCH_URL) {
            if (!/^Bearer fixture-search-key-[12]$/.test(options.headers.Authorization)) throw new Error("Unexpected fixture credential");
            if (JSON.parse(options.body).query === "rate-fixture") return new Response("fixture limited", { status: 429 });
            return Response.json({ results: [{ url: "https://example.invalid/dss", title: "DSS fixture", summary: "Offline DSS result", date: null }] });
        }
        if (url.startsWith("https://api.deepseek.com/")) throw new Error("Unexpected external DeepSeek request");
        return originalFetch(input, options);
    };
    const providerID = Provider.ID.make("websearch-fixture");
    await ctx.provider.transform(editor => editor.add({
        info: { ...Provider.Info.empty(providerID), name: "Offline search fixture", activation: "enabled", package: `aisdk:${import.meta.url}` },
        models: ["test", "long-query", "length-retry"].map(id => Model.Info.default(providerID, Model.ID.make(id))),
    }));
    await ctx.websearch.transform(editor => {
        for (const id of ["exa", "firecrawl", "parallel", "tavily", "tinyfish", "fixture-a", "fixture-b"]) editor.add({
            id, name: id === "fixture-a" ? "Fixture A" : "Fixture B",
            execute: async ({ query }) => {
                if (query === "rate-fixture" && id !== "fixture-b") throw rateLimitError(new Response(null, { status: 429 }));
                return [{ url: `https://example.invalid/${id}`, title: id, content: `Result via ${id}`, time: {} }];
            },
        });
        if (ctx.location.directory === process.cwd()) editor.default.set(ctx.options.defaultSelection ?? "fixture-a");
    });
    return () => { globalThis.fetch = originalFetch; };
} });
