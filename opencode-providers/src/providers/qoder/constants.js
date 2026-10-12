export const PROVIDER_ID = "qoder";
export const PROVIDER_NAME = "Qoder CN";
export const QODER_BASE_URL = "https://gateway.qoder.com.cn/";
export const QODER_OPENAPI_URL = "https://openapi.qoder.com.cn";
export const QODER_CENTER_URL = "https://gateway.qoder.com.cn";
export const QODER_MANAGE_URL = "https://qoder.com.cn";
export const QODER_MODEL_LIST_URL = `${QODER_BASE_URL}algo/api/v2/model/list`;
export const QODER_CHAT_URL = `${QODER_BASE_URL}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
export const QODER_EXCHANGE_URL = `${QODER_OPENAPI_URL}/api/v1/jobToken/exchange`;
export const QODER_USERINFO_URL = `${QODER_OPENAPI_URL}/api/v1/userinfo`;
export const QODER_REFRESH_URL = `${QODER_CENTER_URL}/algo/api/v3/user/refresh_token`;
export const USER_AGENT = "opencode-qoder";
export const ZERO_COST = Object.freeze({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
export const QODER_MODELS = [
    {
        id: "auto",
        name: "Qoder CN Auto",
        reasoning: true,
        supportsEffort: false,
        input: ["text", "image"],
        contextWindow: 200000,
        maxTokens: 32768,
    },
    {
        id: "qmodel_38max",
        name: "Qwen3.8-Max (Qoder CN)",
        reasoning: true,
        supportsEffort: true,
        efforts: ["low", "medium", "xhigh", "none"],
        input: ["text", "image"],
        contextWindow: 1000000,
        maxTokens: 32768,
    },
];
export function getModelDefinition(modelID) {
    return QODER_MODELS.find((model) => model.id === modelID) ?? QODER_MODELS[0];
}
