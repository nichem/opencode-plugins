import { Rpc } from "@opencode/plugin";
import { Schema } from "effect";

const standard = Schema.toStandardSchemaV1;
const State = standard(Schema.Struct({ sessionID: Schema.String, enabled: Schema.Boolean, connected: Schema.Boolean }));
const Session = standard(Schema.Struct({ sessionID: Schema.String }));
export const SkillsRPC = Rpc.define({
    id: "opencode-deepseek-skills",
    methods: {
        state: { input: Session, output: State },
        toggle: { input: Session, output: State },
        create: { input: standard(Schema.Struct({ model: Schema.optional(Schema.Struct({
            providerID: Schema.String, id: Schema.String, variant: Schema.optional(Schema.String),
        })) })), output: State },
    },
    events: {},
});
