import { createHash } from "node:crypto";
import { Provider } from "@opencode/plugin";
import { connectionAuth, API_BASE } from "./auth.js";
import { modelInfo, fallbackModels } from "./models.js";
import * as upstream from "./upstream.js";

const scope = { providerID: "cursor" };
const dialect = { filePathKey: "path", shellTool: "shell", skillArgKey: "id" };
const identity = saved => createHash("sha256").update(saved.connection.id)
    .update(saved.credential.type === "key" ? `\0${saved.credential.key}` : "").digest("hex");

export async function setupCursor(ctx, options = {}, protocol = upstream) {
    for (const name of Object.keys(options)) if (!["enabled", "discoverModels"].includes(name))
        throw new Error(`Cursor: unsupported option '${name}'; credentials must be saved through /connect.`);
    for (const name of ["enabled", "discoverModels"]) if (options[name] !== undefined && typeof options[name] !== "boolean")
        throw new Error(`Cursor: ${name} must be a boolean`);
    const auth = connectionAuth(ctx, protocol);
    await auth.register();
    let models = fallbackModels(), sourceConnection, inventoryAccount, availableModels = [];
    // Discovery is deliberately tied to plugin reload, like the other providers.
    // Never reuse another account's cached inventory or subscribe to global events.
    if (options.discoverModels !== false) {
        try {
            const saved = await auth.read();
            const found = await protocol.fetchModels(await auth.token(saved), { baseURL: API_BASE, timeoutMs: 6000 });
            const current = await auth.read();
            if (identity(saved) === identity(current) && found.length) {
                models = modelInfo(found);
                sourceConnection = saved.connection;
                inventoryAccount = identity(saved);
                availableModels = found;
            }
        } catch { /* Auto remains visible; requests report authentication errors. */ }
    }
    await ctx.provider.transform(editor => editor.add({
        info: { ...Provider.Info.empty(Provider.ID.make("cursor")), name: "Cursor", integrationID: "cursor",
            activation: "enabled", package: `aisdk:${new URL("./sdk.js", import.meta.url).href}` },
        models, ...(sourceConnection ? { sourceConnection } : {}),
    }));

    // Only annotate Cursor calls; never edit prompts, tools, permissions or agent selection.
    for (const name of ["context", "compaction", "generate", "title"]) {
        await ctx.session.hook(name, event => {
            if (event.model.providerID !== "cursor") return;
            event.options ??= {};
            event.options.opencodeCompaction = name === "compaction";
            if (event.agent) event.options.opencodeHostAgent = event.agent;
        }, scope);
    }
    await ctx.session.hook("model.request", async event => {
        if (event.model.providerID !== "cursor") return;
        const session = await ctx.session.get({ sessionID: event.sessionID });
        const directory = session.directory ?? session.location?.directory ?? ctx.location?.directory;
        if (!directory) throw new Error("Cursor: session workspace could not be resolved.");
        event.headers["x-opencode-directory"] = encodeURIComponent(directory);
        event.headers["x-opencode-session-id"] = event.sessionID + (["title", "generate"].includes(event.kind) ? `:${event.kind}` : "");
    }, scope);

    await ctx.aisdk.hook("language", event => {
        if (event.model.providerID !== "cursor") return;
        const modelID = event.model.modelID ?? event.model.id;
        const run = async (method, input) => {
            input.abortSignal?.throwIfAborted();
            const saved = await auth.read();
            const account = identity(saved);
            const headers = { ...input.headers };
            // Isolate Cursor conversation checkpoints when the active account changes.
            const session = headers["x-opencode-session-id"] ?? headers["x-session-id"] ?? headers["X-Session-Id"] ?? headers["x-session-affinity"] ?? headers["x-opencode-session"];
            if (session) headers["x-opencode-session-id"] = `${session}:cursor:${account}`;
            const sdk = protocol.createSdk({ name: "cursor", apiBaseURL: API_BASE, telemetryEnabled: false,
                availableModels: account === inventoryAccount ? availableModels : [],
                defaultDialect: dialect, workspaceRoot: ctx.location?.directory,
                getAccessToken: async request => {
                    input.abortSignal?.throwIfAborted();
                    const active = await auth.read();
                    if (identity(active) !== account) throw new Error("Cursor: account changed during the request; retry this turn.");
                    return auth.token(active, request);
                } });
            input.abortSignal?.throwIfAborted();
            return sdk.languageModel(modelID)[method]({ ...input, headers });
        };
        event.language = { specificationVersion: "v3", provider: "cursor", modelId: modelID, supportedUrls: {},
            doStream: input => run("doStream", input), doGenerate: input => run("doGenerate", input) };
    }, scope);
    return () => auth.dispose();
}
