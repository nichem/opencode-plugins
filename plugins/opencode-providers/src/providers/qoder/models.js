import { CONNECTION_PAT, resolveQoderCredentials } from "./auth.js";
import { buildAuthHeaders } from "./cosy.js";
import { QODER_MODELS, QODER_MODEL_LIST_URL, USER_AGENT } from "./constants.js";

// Discovery failure never hides the bundled models or blocks startup indefinitely.
export async function discoverModels(options = {}) {
    const models = new Map(QODER_MODELS.map(model => [model.id, structuredClone(model)]));
    if (options.discoverModels === false || !options[CONNECTION_PAT])
        return [...models.values()];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
        const credentials = await resolveQoderCredentials(options, controller.signal);
        const headers = buildAuthHeaders("", QODER_MODEL_LIST_URL, {
            userID: credentials.userID, authToken: credentials.access,
            name: credentials.name, email: credentials.email, machineID: credentials.machineID,
        });
        const response = await fetch(QODER_MODEL_LIST_URL, {
            headers: { ...headers, Accept: "application/json", "User-Agent": USER_AGENT },
            signal: controller.signal,
        });
        if (!response.ok) return [...models.values()];
        const data = await response.json();
        const list = Array.isArray(data?.chat) ? data.chat : Array.isArray(data?.models) ? data.models : [];
        for (const entry of list) {
            if (!entry || typeof entry.key !== "string" || !entry.key.trim()) continue;
            const thinking = entry.thinking_config;
            const efforts = thinking?.enabled?.efforts && typeof thinking.enabled.efforts === "object"
                ? Object.keys(thinking.enabled.efforts) : [];
            if (thinking?.disabled && !efforts.includes("none")) efforts.push("none");
            const bundled = models.get(entry.key);
            models.set(entry.key, {
                id: entry.key,
                name: entry.display_name || entry.displayName || entry.key,
                reasoning: typeof entry.is_reasoning === "boolean" ? entry.is_reasoning : bundled?.reasoning ?? false,
                supportsEffort: efforts.length > 0,
                efforts: thinking ? efforts : bundled?.efforts ?? [],
                input: entry.is_vl ? ["text", "image"] : ["text"],
                contextWindow: Number.isSafeInteger(entry.max_input_tokens) && entry.max_input_tokens > 0
                    ? entry.max_input_tokens : bundled?.contextWindow ?? 200000,
                maxTokens: bundled?.maxTokens ?? 32768,
            });
        }
    } catch {
        // Keep the offline inventory when authentication, networking or decoding fails.
    } finally {
        clearTimeout(timer);
    }
    return [...models.values()];
}
