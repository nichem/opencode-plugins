import type { Plugin } from "@opencode/plugin/tui"
import { GoalRPC } from "./src/rpc.ts"

export default {
  id: "opencode-goal.tui",
  setup(ctx) {
    return ctx.client.rpc(GoalRPC).events.on("notice", event => {
      const { sessionID, message } = event.data
      if (typeof sessionID !== "string" || typeof message !== "string") return
      ctx.ui.toast.show({ sessionID, message, variant: "info", duration: 8000 })
    })
  },
} satisfies Plugin.Definition
