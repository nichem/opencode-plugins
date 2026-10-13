import { Plugin } from "@opencode/plugin";
import { setupQoder } from "./providers/qoder/index.js";
import { setupKrill } from "./providers/krill/index.js";

// Each provider owns its authentication, model discovery and transport.
const providers = new Map([["qoder", setupQoder], ["krill", setupKrill],
    ["cursor", async (ctx, config) => (await import("./providers/cursor/index.js")).setupCursor(ctx, config)]]);

export default Plugin.define({
    id: "opencode-providers",
    async setup(ctx) {
        const options = ctx.options.providers ?? {};
        if (typeof options !== "object" || options === null || Array.isArray(options))
            throw new Error("opencode-providers: providers must be an object");
        for (const name of Object.keys(options)) {
            if (!providers.has(name))
                throw new Error(`opencode-providers: unknown provider '${name}'`);
        }
        const cleanups = [];
        for (const [name, setup] of providers) {
            const config = options[name] ?? {};
            if (config === null || typeof config !== "object" || Array.isArray(config))
                throw new Error(`opencode-providers: providers.${name} must be an object`);
            if (config.enabled === false) continue;
            const cleanup = await setup(ctx, config);
            if (cleanup) cleanups.push(cleanup);
        }
        return async () => { for (const cleanup of cleanups.reverse()) await cleanup(); };
    },
});
