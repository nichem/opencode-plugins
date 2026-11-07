import { CONNECTION_PAT, resolveQoderCredentials } from "./auth.js";
import { buildAuthHeaders } from "./cosy.js";
import { QODER_CN, USER_AGENT } from "./constants.js";

function priceFactor(value) {
    if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
    const factor = Number(value);
    return Number.isFinite(factor) && factor >= 0 ? factor : undefined;
}

// Discovery failure never hides the bundled models or blocks startup indefinitely.
export async function discoverModels(options = {}, region = QODER_CN) {
    const models = new Map(region.models.map(model => [model.id, structuredClone(model)]));
    if (options.discoverModels === false || !options[CONNECTION_PAT])
        return [...models.values()];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
        const credentials = await resolveQoderCredentials(options, controller.signal, region);
        const headers = buildAuthHeaders("", region.modelListURL, {
            userID: credentials.userID, authToken: credentials.access,
            name: credentials.name, email: credentials.email, machineID: credentials.machineID,
        });
        const response = await fetch(region.modelListURL, {
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
                priceFactor: priceFactor(entry.price_factor),
                originalPriceFactor: priceFactor(entry.original_price_factor),
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
