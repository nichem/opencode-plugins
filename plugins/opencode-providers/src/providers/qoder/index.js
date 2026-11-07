import { Model, Provider } from "@opencode/plugin";
import { QoderLanguageModel } from "./language-model.js";
import { discoverModels } from "./models.js";
import { QODER_CN } from "./constants.js";
import { CONNECTION_PAT } from "./auth.js";

function stringOption(value, name) {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new Error(`Qoder: ${name} must be a nonempty string`);
    return value.trim();
}

export function modelInfo(providerID, model) {
    // Credit multipliers are display metadata, not USD per million tokens.
    const factor = model.priceFactor;
    const original = model.originalPriceFactor;
    const priceLabel = factor === undefined ? "" : ` · ${factor}×${original !== undefined && original !== factor ? `（原 ${original}×）` : ""}`;
    return {
        ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(model.id)),
        name: model.name + priceLabel,
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
    constructor(modelID, options, resolveOptions, region, providerID) {
        super(modelID, options, region, providerID);
        this.resolveOptions = resolveOptions;
    }
    async doStream(options) {
        options.abortSignal?.throwIfAborted();
        const providerOptions = await this.resolveOptions();
        options.abortSignal?.throwIfAborted();
        return new QoderLanguageModel(this.modelId, providerOptions, this.region, this.provider).doStream(options);
    }
}

export async function setupQoder(ctx, options = {}, region = QODER_CN) {
    const id = stringOption(options.providerID, "providerID") ?? region.id;
    await ctx.integration.transform(editor => {
        editor.update(id, integration => { integration.name = region.name; });
        editor.method.update({ integrationID: id, method: { type: "key", label: `${region.name} Personal Access Token` } });
    });

    const resolveOptions = async (sdkOptions = {}) => {
        const connection = await ctx.integration.connection.active(id);
        const credential = connection?.type === "credential" ? await ctx.integration.connection.resolve(connection) : undefined;
        if (credential && credential.type !== "key")
            throw new Error(`${region.name} requires a Personal Access Token; reconnect using the key method`);
        return { ...sdkOptions, [CONNECTION_PAT]: credential?.key };
    };

    // Credential resolution errors should not prevent the provider from being registered.
    let discoveryOptions = {};
    if (options.discoverModels !== false) {
        try { discoveryOptions = await resolveOptions(); } catch { /* bundled models remain usable after reconnecting */ }
    }
    const definitions = await discoverModels({ ...discoveryOptions, discoverModels: options.discoverModels }, region);
    const inventory = new Map(definitions.map(model => [model.id, model]));

    await ctx.aisdk.hook("language", event => {
        if (event.model.providerID !== id) return;
        const modelID = event.model.modelID ?? event.model.id;
        event.language = new ConnectedQoderModel(modelID, event.options, async () => ({
            ...await resolveOptions(event.options),
            modelDefinition: inventory.get(modelID),
        }), region, id);
    }, { providerID: id });

    await ctx.provider.transform(editor => {
        editor.add({
            info: {
                ...Provider.Info.empty(Provider.ID.make(id)),
                name: region.name,
                integrationID: id,
                // Keep bundled models visible so disconnected requests can explain /connect.
                activation: "enabled",
                package: region.sdkPackage,
            },
            models: definitions.map(model => modelInfo(id, model)),
        });
    });
    if (options.setDefault === true) {
        await ctx.model.transform(editor => editor.default.set(id, "auto"));
    }
}
