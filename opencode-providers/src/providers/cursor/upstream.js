// Private module imports are deliberately tied to the exact dependency version.
// Never import or run plugin.js / plugin-opencode2.js: those register host-wide hooks.
const root = new URL(import.meta.resolve("cursor-opencode-provider"));
const [renewal, mapping] = await Promise.all([
    import(new URL("auth-renewal.js", root).href),
    import(new URL("model-config.js", root).href),
]);
export { fetchModels } from "cursor-opencode-provider/models";
export { toOpenCode2Costs } from "cursor-opencode-provider/pricing";
export { generatePkceParams, generatePkceChallenge, buildLoginUrl, decodeJwtExpiryMs, isExchangeableApiKey } from "cursor-opencode-provider/auth";
export { createSdk } from "./vendor/protocol.js";
export const { resolveApiKeyToken, renewSessionIfDue } = renewal;
export const { modelsToConfig } = mapping;
