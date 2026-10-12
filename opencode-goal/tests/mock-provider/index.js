import { Plugin, Provider, Model } from "@opencode/plugin"

// Deterministic local model: one unfinished turn, then update_goal, then a final reply.
// No remote API or real credentials are involved.
let calls = 0
export function createMock() {
  return { languageModel: (modelID) => ({
    specificationVersion: "v3", provider: "goal-test", modelId: modelID, supportedUrls: {},
    async doStream(options) {
      const slow = modelID === "slow"
      if (slow) await new Promise(resolve => setTimeout(resolve, 1200))
      calls++
      const complete = !slow && calls === 2 && options.tools?.some(tool => tool.name === "update_goal")
      const parts = [{ type: "stream-start", warnings: [] }]
      if (complete) parts.push({ type: "tool-call", toolCallId: "goal-complete", toolName: "update_goal", input: '{"status":"complete"}' })
      else parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: `Smoke turn ${calls}` }, { type: "text-end", id: "t" })
      parts.push({ type: "finish", finishReason: { unified: complete ? "tool-calls" : "stop", raw: complete ? "tool_calls" : "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } })
      if (!slow && calls > 5) throw new Error("Smoke model loop exceeded limit; update_goal was not called")
      return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } }) }
    },
  }) }
}

export default Plugin.define({ id: "goal-test-provider", async setup(ctx) {
  const providerID = Provider.ID.make("goal-test")
  await ctx.provider.transform(editor => editor.add({
    info: { ...Provider.Info.empty(providerID), name: "Goal test (offline)", activation: "enabled", package: `aisdk:${import.meta.url}` },
    models: ["test", "slow"].map(id => Model.Info.default(providerID, Model.ID.make(id))),
  }))
  await ctx.model.transform(editor => editor.default.set("goal-test", "test"))
} })
