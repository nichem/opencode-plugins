import { Rpc } from "@opencode/plugin"
import { Schema } from "effect"

const Item = Schema.Struct({
  label: Schema.String,
  value: Schema.optionalKey(Schema.String),
  used: Schema.optionalKey(Schema.Finite),
  limit: Schema.optionalKey(Schema.Finite),
  unit: Schema.optionalKey(Schema.String),
  resetsAt: Schema.optionalKey(Schema.String),
})

export const QuotaRPC = Rpc.define({
  id: "opencode-quota",
  methods: {
    query: {
      input: Schema.toStandardSchemaV1(Schema.Struct({
        providerID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        modelID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      })),
      output: Schema.toStandardSchemaV1(Schema.Struct({
        providerID: Schema.String,
        modelID: Schema.String,
        status: Schema.Literals(["ready", "unconfigured", "error"]),
        title: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String),
        updatedAt: Schema.optionalKey(Schema.Finite),
        items: Schema.Array(Item),
      })),
    },
  },
  events: {},
})
