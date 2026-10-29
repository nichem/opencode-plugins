import { Model, Plugin, Provider, Rpc } from "@opencode/plugin"

// Only record booleans/counts from artificial requests, never prompt contents.
const requests = []
export function createMock() {
  return { languageModel: modelID => ({
    specificationVersion: "v3", provider: "behavior-fixture", modelId: modelID, supportedUrls: {},
    async doStream(options) {
      const prompt = JSON.stringify(options.prompt)
      requests.push({ modelID, copies: prompt.split("<deepseek_behavior>").length - 1 })
      const parts = [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "fixture" },
        { type: "text-delta", id: "fixture", delta: "Behavior fixture reply" }, { type: "text-end", id: "fixture" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }]
      return { stream: new ReadableStream({ start(controller) {
        for (const part of parts) controller.enqueue(part)
        controller.close()
      } }) }
    },
  }) }
}

const FixtureRPC = Rpc.define({
  id: "deepseek-behavior-fixture",
  methods: { requests: {
    input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "array", items: { type: "object", properties: {
      modelID: { type: "string" }, copies: { type: "number" },
    }, required: ["modelID", "copies"], additionalProperties: false } },
  } }, events: {},
})

export default Plugin.define({ id: "deepseek-behavior-fixture", async setup(ctx) {
  const providerID = Provider.ID.make("behavior-fixture")
  await ctx.provider.transform(editor => editor.add({
    info: { ...Provider.Info.empty(providerID), name: "Behavior fixture (offline)",
      activation: "enabled", package: `aisdk:${import.meta.url}` },
    models: ["DeepSeek-fixture", "ordinary-fixture"].map(id => Model.Info.default(providerID, Model.ID.make(id))),
  }))
  const rpc = await ctx.rpc.register(FixtureRPC, { requests: async () => [...requests] })
  return () => rpc.dispose()
} })
