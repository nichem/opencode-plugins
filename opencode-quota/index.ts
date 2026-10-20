import { Plugin } from "@opencode/plugin"
import { options } from "./src/options.ts"
import { QuotaRPC } from "./src/rpc.ts"
import { QuotaService } from "./src/service.ts"

export default Plugin.define({
  id: "opencode-quota",
  async setup(ctx) {
    const service = new QuotaService(options(ctx.options, ctx.location.directory), {
      async resolve(providerID) {
        const { data: provider } = await ctx.provider.get({ providerID })
        if (!provider.integrationID) return
        const connection = await ctx.integration.connection.active(provider.integrationID)
        if (connection?.type !== "credential") return
        return ctx.integration.connection.resolve(connection)
      },
    })
    try {
      const registration = await ctx.rpc.register(QuotaRPC, {
        query: (input, context) => service.query(input, context.signal),
      })
      return async () => { service.close(); await registration.dispose() }
    } catch (error) {
      service.close()
      throw error
    }
  },
})
