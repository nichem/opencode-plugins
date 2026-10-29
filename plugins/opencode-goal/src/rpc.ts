import { Rpc } from "@opencode/plugin"

export const GoalRPC = Rpc.define({
  id: "opencode-goal",
  methods: {
    status: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
    },
  },
  events: {
    notice: { schema: { type: "object", properties: { sessionID: { type: "string" }, message: { type: "string" } },
      required: ["sessionID", "message"], additionalProperties: false } },
  },
})
