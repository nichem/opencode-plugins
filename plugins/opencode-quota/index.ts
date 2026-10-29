import { Plugin } from "@opencode/plugin"
import { allowsBuiltin, QuotaEndpointError } from "./src/builtins.ts"
import { resolveConnection } from "./src/connection.ts"
import { options } from "./src/options.ts"
import { QuotaRPC } from "./src/rpc.ts"
import { QuotaService } from "./src/service.ts"

export default Plugin.define({
  id: "opencode-quota",
  async setup(ctx) {
    const service = new QuotaService(options(ctx.options, ctx.location.directory), {
      async resolve(providerID, modelID) {
        const { data: provider } = await ctx.provider.get({ providerID })
        if (modelID !== undefined) {
          const { data: models } = await ctx.model.list()
          const model = models.find(item => item.providerID === providerID && item.id === modelID)
          if (!model || !allowsBuiltin(providerID, provider, model)) throw new QuotaEndpointError()
        }
        return resolveConnection(providerID, provider.integrationID, ctx.integration.connection)
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
