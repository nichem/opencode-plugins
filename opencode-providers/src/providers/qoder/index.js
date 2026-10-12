import { Model, Provider } from "@opencode/plugin";
import { QoderLanguageModel } from "./language-model.js";
import { discoverModels } from "./models.js";
import { PROVIDER_ID, PROVIDER_NAME } from "./constants.js";
import { CONNECTION_PAT } from "./auth.js";

const sdkPackage = `aisdk:${new URL("./language-model.js", import.meta.url).href}`;

function stringOption(value, name) {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new Error(`Qoder: ${name} must be a nonempty string`);
    return value.trim();
}

export function modelInfo(providerID, model) {
    return {
        ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(model.id)),
        name: model.name,
        capabilities: { tools: true, input: model.input, output: ["text"] },
        variants: (model.efforts ?? []).map(level => ({
            id: Model.VariantID.make(level), settings: { reasoningEffort: level },
        })),
        cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
        limit: { context: model.contextWindow, input: model.contextWindow, output: model.maxTokens },
    };
}

// OpenCode caches SDK/model instances. Resolve the active account on each request,
// rather than capturing a PAT once and continuing to use it after /connect changes.
class ConnectedQoderModel extends QoderLanguageModel {
    constructor(modelID, options, resolveOptions) {
        super(modelID, options);
        this.resolveOptions = resolveOptions;
    }
    async doStream(options) {
        options.abortSignal?.throwIfAborted();
        const providerOptions = await this.resolveOptions();
        options.abortSignal?.throwIfAborted();
        return new QoderLanguageModel(this.modelId, providerOptions).doStream(options);
    }
}

export async function setupQoder(ctx, options = {}) {
    const id = stringOption(options.providerID, "providerID") ?? PROVIDER_ID;
    await ctx.integration.transform(editor => {
        editor.update(id, integration => { integration.name = PROVIDER_NAME; });
        editor.method.update({ integrationID: id, method: { type: "key", label: "Qoder CN Personal Access Token" } });
    });

    const resolveOptions = async (sdkOptions = {}) => {
        const connection = await ctx.integration.connection.active(id);
        const credential = connection?.type === "credential" ? await ctx.integration.connection.resolve(connection) : undefined;
        if (credential && credential.type !== "key")
            throw new Error("Qoder CN requires a Personal Access Token; reconnect using the key method");
        return { ...sdkOptions, [CONNECTION_PAT]: credential?.key };
    };

    // Credential resolution errors should not prevent the provider from being registered.
    let discoveryOptions = {};
    if (options.discoverModels !== false) {
        try { discoveryOptions = await resolveOptions(); } catch { /* bundled models remain usable after reconnecting */ }
    }
    const definitions = await discoverModels({ ...discoveryOptions, discoverModels: options.discoverModels });
    const inventory = new Map(definitions.map(model => [model.id, model]));

    await ctx.aisdk.hook("language", event => {
        if (event.model.providerID !== id) return;
        const modelID = event.model.modelID ?? event.model.id;
        event.language = new ConnectedQoderModel(modelID, event.options, async () => ({
            ...await resolveOptions(event.options),
            modelDefinition: inventory.get(modelID),
        }));
    }, { providerID: id });

    await ctx.provider.transform(editor => {
        editor.add({
            info: {
                ...Provider.Info.empty(Provider.ID.make(id)),
                name: PROVIDER_NAME,
                integrationID: id,
                // Keep bundled models visible so disconnected requests can explain /connect.
                activation: "enabled",
                package: sdkPackage,
            },
            models: definitions.map(model => modelInfo(id, model)),
        });
    });
    if (options.setDefault === true) {
        await ctx.model.transform(editor => editor.default.set(id, "auto"));
    }
}
