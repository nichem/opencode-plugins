import { Plugin } from "@opencode/plugin"
import { BEHAVIOR_PROMPT, BehaviorSettings, isDeepSeek } from "./src/behavior.ts"
import { BehaviorRPC } from "./src/rpc.ts"

export default Plugin.define({
  id: "opencode-deepseek-behavior",
  async setup(ctx) {
    const settings = new BehaviorSettings(ctx.storage)
    const rpc = await ctx.rpc.register(BehaviorRPC, {
      get: () => settings.get(),
      set: async ({ enabled }) => {
        const state = await settings.set(enabled)
        // A notification failure must not turn a durable save into a reported failure.
        await rpc.events.emit("changed", state).catch(() => {})
        return state
      },
    })
    try {
      const hook = await ctx.session.hook("context", async event => {
        if (!isDeepSeek(event.model.id) || !(await settings.get()).enabled) return
        if (!event.system.some(part => part.type === "text" && part.text === BEHAVIOR_PROMPT))
          event.system.push({ type: "text", text: BEHAVIOR_PROMPT })
      })
      return async () => { await hook.dispose(); await rpc.dispose() }
    } catch (error) {
      await rpc.dispose()
      throw error
    }
  },
})
