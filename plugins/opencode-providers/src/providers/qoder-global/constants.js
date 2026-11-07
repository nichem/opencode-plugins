// Global endpoints from the original opencode-qoder transport. Never infer a
// region from a PAT: both regions use the same prefix.
export const QODER_GLOBAL = Object.freeze({
    id: "qoder-global",
    name: "Qoder Global",
    region: "global",
    exchangeURL: "https://openapi.qoder.sh/api/v1/jobToken/exchange",
    userInfoURL: "https://openapi.qoder.sh/api/v1/userinfo",
    modelListURL: "https://api3.qoder.sh/algo/api/v2/model/list",
    chatURL: "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
    models: [{
        id: "auto",
        name: "Qoder Global Auto",
        reasoning: true,
        supportsEffort: false,
        input: ["text", "image"],
        contextWindow: 180000,
        maxTokens: 32768,
    }],
    sdkPackage: `aisdk:${new URL("./language-model.js", import.meta.url).href}`,
});
