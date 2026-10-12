import { createOpenAI } from "@ai-sdk/openai";
import { Provider } from "@opencode/plugin";
import { discoverModels, validateOptions } from "./models.js";

export async function setupKrill(ctx, options = {}) {
    const id = options.providerID ?? "krill";
    if (typeof id !== "string" || !id.trim()) throw new Error("Krill: providerID must be a nonempty string");
    const { baseURL } = validateOptions(options);
    await ctx.integration.transform(editor => {
        editor.update(id, entry => { entry.name = "Krill"; });
        editor.method.update({ integrationID: id, method: { type: "key", label: "Krill API Key" } });
    });
    const resolveKey = async () => {
        const connection = await ctx.integration.connection.active(id);
        const credential = connection?.type === "credential" ? await ctx.integration.connection.resolve(connection) : undefined;
        if (credential?.type !== "key" || !credential.key?.trim()) throw new Error("Krill API Key not set. Use /connect → Krill to connect.");
        return credential.key;
    };
    const definitions = await discoverModels(id, options, resolveKey);
    await ctx.aisdk.hook("sdk", event => {
        if (event.model.providerID !== id) return;
        const transport = event.options.fetch ?? globalThis.fetch;
        // SDKs are cached by OpenCode. Resolve the current account at request
        // time, and never accept API keys from config or environment variables.
        event.sdk = createOpenAI({ ...event.options, baseURL, apiKey: "opencode-krill-connection",
            fetch: async (input, init) => {
                const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
                signal?.throwIfAborted();
                const key = await resolveKey();
                signal?.throwIfAborted();
                const url = new URL(input instanceof Request ? input.url : String(input));
                if (!url.href.startsWith(`${baseURL}/`)) throw new Error("Krill: unexpected request destination");
                const headers = new Headers(input instanceof Request ? input.headers : undefined);
                new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
                headers.set("Authorization", `Bearer ${key}`);
                return transport(input, { ...init, headers, redirect: "error" });
            },
        });
    }, { providerID: id });
    await ctx.aisdk.hook("language", event => {
        if (event.model.providerID === id) event.language = event.sdk.responses(event.model.modelID ?? event.model.id);
    }, { providerID: id });
    await ctx.provider.transform(editor => editor.add({
        info: { ...Provider.Info.empty(Provider.ID.make(id)), name: "Krill", integrationID: id,
            activation: "enabled", package: "aisdk:@ai-sdk/openai", settings: { baseURL, setCacheKey: true } },
        models: definitions,
    }));
}
