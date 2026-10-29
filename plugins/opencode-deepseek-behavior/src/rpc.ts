import { Rpc } from "@opencode/plugin"
import { Schema } from "effect"

const State = Schema.toStandardSchemaV1(Schema.Struct({ enabled: Schema.Boolean }))
export const BehaviorRPC = Rpc.define({
  id: "opencode-deepseek-behavior",
  methods: {
    get: { input: Schema.toStandardSchemaV1(Schema.Struct({})), output: State },
    set: { input: State, output: State },
  },
  events: { changed: { schema: State } },
})
