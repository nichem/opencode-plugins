import { Plugin, Provider } from "@opencode/plugin"

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
  },
})
