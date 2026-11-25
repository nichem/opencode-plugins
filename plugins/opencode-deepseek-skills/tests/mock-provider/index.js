import { Plugin, Provider, Model } from "@opencode/plugin";

export function createMock() {
    return { languageModel: modelID => ({
        specificationVersion: "v3", provider: "skills-fixture", modelId: modelID, supportedUrls: {},
        async doStream(options) {
            const names = (options.tools ?? []).map(tool => tool.name);
            const own = names.filter(name => name.startsWith("deepseek_"));
            const history = JSON.stringify(options.prompt);
            let call;
            if (modelID === "execute" && own.includes("deepseek_skill") && !history.includes('"toolName":"deepseek_skill"'))
                call = { name: "deepseek_skill", input: { skill: "search" } };
            else if (modelID === "execute" && own.includes("deepseek_run") && !history.includes('"toolName":"deepseek_run"'))
                call = { name: "deepseek_run", input: { skill: "search", input: { query: "offline fixture" } } };
            const parts = [{ type: "stream-start", warnings: [] }];
            if (call) parts.push({ type: "tool-call", toolCallId: call.name, toolName: call.name, input: JSON.stringify(call.input) });
            else parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: `Fixture done: ${own.join(",") || "hidden"}` },
                { type: "text-end", id: "t" });
            parts.push({ type: "finish", finishReason: { unified: call ? "tool-calls" : "stop", raw: call ? "tool_calls" : "stop" },
                usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
            return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) };
        },
    }) };
}

export default Plugin.define({ id: "skills-fixture", async setup(ctx) {
    const previous = globalThis.fetch;
    globalThis.fetch = async (input, options) => {
        const url = typeof input === "string" ? input : input.url ?? String(input);
        if (url === "https://api.deepseek.com/v1/tools/search") {
            if (!/^Bearer fixture-search-key-[12]$/.test(options.headers.Authorization)) throw new Error("Unexpected fixture credential");
            return Response.json({ results: [{ title: "Offline fixture", url: "https://example.invalid", summary: "Simulated Search response" }] });
        }
        if (url.startsWith("https://api.deepseek.com/")) throw new Error("Unexpected DeepSeek network access");
        return previous(input, options);
    };
    const providerID = Provider.ID.make("skills-fixture");
    await ctx.provider.transform(editor => editor.add({
        info: { ...Provider.Info.empty(providerID), name: "Offline skills fixture", activation: "enabled", package: `aisdk:${import.meta.url}` },
        models: ["inspect", "execute"].map(id => Model.Info.default(providerID, Model.ID.make(id))),
    }));
    return () => { globalThis.fetch = previous; };
} });
