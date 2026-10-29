import { SearchService } from "../src/service.js";

export async function fixture({ configured, saved, credential, transport, nativeDefault, sessionLocations = {} } = {}) {
    const storage = new Map(Object.entries(saved ?? {}));
    const native = [{ id: "exa", name: "Exa" }, { id: "tavily", name: "Tavily" }];
    const providers = new Map();
    let service;
    const calls = { permission: [], query: [], native: [] };
    const ctx = {
        location: { directory: "/fixture/project" },
        storage: { get: async key => storage.get(key), set: async (key, value) => { storage.set(key, value); },
            remove: async key => { storage.delete(key); } },
        session: { get: async ({ sessionID }) => ({ id: sessionID, location: { directory: sessionLocations[sessionID] ?? ctx.location.directory } }) },
        integration: { connection: {
            active: async id => { if (id !== "dss") throw new Error("Unexpected integration"); return credential ? { type: "credential", id: "test" } : undefined; },
            resolve: async () => credential,
        } },
        websearch: {
            reload: async () => { providers.clear(); service.transform({ add: provider => providers.set(provider.id, provider),
                default: { get: () => nativeDefault, set: value => { ctx.selected = value; } } }); },
            providers: async () => ({ data: [...native, ...providers.values()].map(({ id, name }) => ({ id, name })) }),
            query: async (input, options) => { calls.query.push({ input, options }); return { data: { providerID: input.providerID,
                results: [{ url: "https://example.invalid", title: "Fixture", content: "Result", time: {} }] } }; },
        },
        permission: { assert: async input => { calls.permission.push(input); } },
    };
    const configuration = {
        read: async sources => sources ? sources.reduce((selection, source) => source.websearch === false ? false : source.websearch?.provider ?? selection, undefined)
            : storage.has("fixture-config") ? storage.get("fixture-config") : configured,
        write: async providerID => { const changed = await configuration.read() !== providerID; storage.set("fixture-config", providerID); return changed; },
    };
    service = new SearchService(ctx, { transport, configuration });
    await service.initialize();
    await ctx.websearch.reload();
    return { ctx, service, storage, providers, calls, switchCredential: value => { credential = value; },
        switchNativeDefault: value => { nativeDefault = value; } };
}
