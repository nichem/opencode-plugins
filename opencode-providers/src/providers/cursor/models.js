import { Model, Provider } from "@opencode/plugin";
import { modelsToConfig, toOpenCode2Costs } from "./upstream.js";

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
export const fallbackModels = () => modelInfo([{ id: "default", displayName: "Cursor Auto", supportsAgent: true, variants: [] }]);
