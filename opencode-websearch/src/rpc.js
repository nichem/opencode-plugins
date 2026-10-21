import { Rpc } from "@opencode/plugin";

const string = { type: "string", minLength: 1 };
const sources = { type: "array", items: {
    type: "object", properties: { path: string, websearch: { anyOf: [
        { const: false },
        { type: "object", properties: { provider: string }, required: ["provider"], additionalProperties: false },
    ] } }, required: ["websearch"], additionalProperties: false,
} };
const state = {
    type: "object",
    properties: {
        defaultProvider: string,
        sessionProvider: string,
        enabled: { type: "boolean" },
        reloadRequired: { type: "boolean" },
        providers: { type: "array", items: {
            type: "object",
            properties: { id: string, name: string, available: { type: "boolean" } },
            required: ["id", "name", "available"], additionalProperties: false,
        } },
    },
    required: ["defaultProvider", "enabled", "providers"], additionalProperties: false,
};

export const SearchRPC = Rpc.define({
    id: "opencode-websearch",
    methods: {
        state: {
            input: { type: "object", properties: { sessionID: string, sources }, required: ["sources"], additionalProperties: false },
            output: state,
            errors: { selection: { type: "object", properties: {}, additionalProperties: false } },
        },
        select: {
            input: {
                type: "object",
                properties: { providerID: string, scope: { enum: ["default", "session"] }, sessionID: string, sources },
                required: ["providerID", "scope", "sources"], additionalProperties: false,
            },
            output: state,
            errors: { selection: { type: "object", properties: {}, additionalProperties: false } },
        },
    },
    events: {},
});
