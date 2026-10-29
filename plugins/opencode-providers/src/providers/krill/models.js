import { Model, Provider } from "@opencode/plugin";

export const BASE_URL = "https://api.krill-code.net/codex/v1";
const bundled = ["gpt-5.6-sol", "gpt-6.1-sol"];
const efforts = ["low", "medium", "high", "xhigh"];

export function modelInfo(providerID, id, overrides = {}) {
    const known = bundled.includes(id);
    return {
        ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id)),
        name: overrides.name ?? id,
        capabilities: { tools: true, input: overrides.input ?? ["text"], output: ["text"] },
        // /models reports IDs only. Preserve the user's original limits for the
        // two bundled models; use conservative, configurable defaults otherwise.
        limit: { context: overrides.contextWindow ?? (known ? 272000 : 200000), output: overrides.maxTokens ?? (known ? 128000 : 32768) },
        settings: { reasoningEffort: "medium", reasoningSummary: "auto", store: false, textVerbosity: "low" },
        variants: (overrides.efforts ?? efforts).map(id => ({ id: Model.VariantID.make(id), settings: { reasoningEffort: id, textVerbosity: "low" } })),
    };
}

export function validateOptions(options) {
    const url = new URL(options.baseURL ?? BASE_URL);
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
        throw new Error("Krill: baseURL must be HTTPS (HTTP is allowed for loopback tests only)");
    const models = options.models === undefined ? {} : options.models;
    if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("Krill: models must be an object");
    for (const [id, model] of Object.entries(models)) {
        if (!id.trim() || !model || typeof model !== "object" || Array.isArray(model)) throw new Error("Krill: invalid model configuration");
        for (const field of ["contextWindow", "maxTokens"]) {
            if (model[field] !== undefined && (!Number.isSafeInteger(model[field]) || model[field] <= 0)) throw new Error(`Krill: ${field} must be a positive integer`);
        }
        if (model.name !== undefined && (typeof model.name !== "string" || !model.name.trim())) throw new Error("Krill: model name must be nonempty");
        if (model.efforts !== undefined && (!Array.isArray(model.efforts) || model.efforts.some(x => typeof x !== "string" || !x.trim()))) throw new Error("Krill: efforts must be an array of nonempty strings");
        if (model.input !== undefined && (!Array.isArray(model.input) || !model.input.length || model.input.some(x => !["text", "image"].includes(x)))) throw new Error("Krill: input must contain text or image");
    }
    return { baseURL: url.href.replace(/\/+$/, ""), models };
}

export async function discoverModels(providerID, options, resolveKey, fetcher = globalThis.fetch) {
    const { baseURL, models } = validateOptions(options);
    const ids = new Set(bundled);
    if (options.discoverModels !== false) {
        try {
            const key = await resolveKey();
            const response = await fetcher(`${baseURL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000), redirect: "error" });
            if (response.ok) {
                const body = await response.json();
                // The gateway list includes non-Codex models. Do not advertise
                // Claude, images, audio, etc. on the Responses transport.
                for (const item of Array.isArray(body.data) ? body.data : []) {
                    if (typeof item?.id === "string" && /^gpt-\d[\w.-]*$/i.test(item.id) && !/image|audio|realtime|transcri|tts|search/i.test(item.id)) ids.add(item.id);
                }
            }
        } catch { /* Missing key / unavailable discovery keeps the bundled models. */ }
    }
    for (const id of Object.keys(models)) ids.add(id);
    return [...ids].map(id => modelInfo(providerID, id, models[id]));
}
