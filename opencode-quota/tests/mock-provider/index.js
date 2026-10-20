import { Model, Plugin, Provider } from "@opencode/plugin"

export default Plugin.define({
  id: "quota-test-provider",
  async setup(ctx) {
    await ctx.integration.transform(editor => {
      editor.update("quota-fixture", integration => { integration.name = "Quota Fixture" })
      editor.method.update({ integrationID: "quota-fixture", method: { type: "key", label: "Fixture Key" } })
    })
    await ctx.provider.transform(editor => editor.add({
      info: { ...Provider.Info.empty(Provider.ID.make("quota-fixture")), name: "Quota Fixture",
        integrationID: "quota-fixture", activation: "enabled", package: "aisdk:@ai-sdk/openai" },
      models: [],
    }))
    const blocked = Provider.ID.make("deepseek")
    await ctx.provider.transform(editor => editor.add({
      info: { ...Provider.Info.empty(blocked), name: "Blocked Quota Fixture", integrationID: "quota-fixture",
        activation: "enabled", package: "@opencode/ai/providers/deepseek",
        settings: { baseURL: "https://quota-proxy.example.invalid/v1" } },
      models: [Model.Info.default(blocked, Model.ID.make("quota-endpoint-fixture"))],
    }))
  },
})
