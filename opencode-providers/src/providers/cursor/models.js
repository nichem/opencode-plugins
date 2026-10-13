import { Model, Provider } from "@opencode/plugin";
import { modelsToConfig, toOpenCode2Costs } from "./upstream.js";

// Cursor Models usage pool, verified against https://cursor.com/docs/models-and-pricing.
// Discovery has no pool field. Keep explicit IDs so Auto and unknown models cannot
// enter the catalog just because of their display name or a future model prefix.
const cursorPoolIDs = new Set([
    "composer-2.5", "composer-2.5-fast",
    "grok-4.5", "grok-4.5-fast",
    "grok-4.6", "grok-4.6-fast",
    "grok-4.7", "grok-4.7-fast",
]);

export const cursorPoolModels = models => models.filter(model => cursorPoolIDs.has(model.id));

export function modelInfo(models) {
    return Object.entries(modelsToConfig(models)).map(([id, entry]) => ({
        ...Model.Info.default(Provider.ID.make("cursor"), Model.ID.make(id)),
        modelID: entry.options?.cursorModelId ?? id, name: entry.name,
        ...(entry.family ? { family: entry.family } : {}),
        capabilities: { tools: entry.tool_call !== false, input: entry.modalities.input, output: entry.modalities.output },
        limit: { context: entry.limit.context, input: entry.limit.context, output: entry.limit.output },
        cost: toOpenCode2Costs(entry.cost), settings: entry.options ?? {},
        variants: Object.entries(entry.variants ?? {}).map(([id, settings]) => ({ id: Model.VariantID.make(id), settings })),
    }));
}
