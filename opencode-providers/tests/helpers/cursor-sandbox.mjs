import vm from "node:vm";
import { readFile } from "node:fs/promises";

// Run the shipped bundle unchanged apart from test-only external I/O injection.
// All credentials, directories, checkpoints and protocol frames are fabricated.
const source = await readFile(new URL("../../src/providers/cursor/vendor/protocol.js", import.meta.url), "utf8");
export async function cursorSandbox(t, io = {}) {
    const module = new vm.SourceTextModule(source + `
export const fixtureTransport = bidiRunStream;
export const fixtureLifetime = createCallLifetime;
export const fixtureCollectGit = collectGit;
export const fixtureWindowsMachineGuid = readWindowsMachineGuid;
export function fixtureIO(io) {
    loadMergedConfig = async () => ({});
    hydrateConversationState = async () => undefined;
    hydrateTurnProvenance = async (cache, key) => io.hydrate?.(key);
    persistConversationState = async () => {};
    clearPersistedConversationState = async (cache, key, previous) => io.clear?.(key, previous);
    resolveAgentUrl = async () => "https://api2.cursor.sh";
    if (io.h2Session) {
        getSession = io.h2Session;
        resolveClientVersion = async () => "fixture-version";
    }
    bidiRunStream = io.open;
    getOrBuildRequestContext = io.context ?? (async () => ({ context: {}, reused: false }));
}
export function fixtureSeed(key, parts, restored = false) {
    const conversationId = peekConversationId(key);
    trackTurnProvenance(key, conversationId);
    for (const part of parts) recordEmittedPart(key, conversationId, part);
    const checkpoint = encodeMessage("ConversationStateStructure", {
        root_prompt_messages_json: [JSON.stringify({ role: "assistant", content: "fixture deleted checkpoint" })],
    });
    setCheckpoint(conversationId, checkpoint);
    const provenance = serializeTurnProvenance(getTurnProvenance(key));
    if (restored) provenanceBySession.delete(key);
    return { conversationId, checkpoint, provenance };
}
export function fixtureRestore(key, raw) { restoreTurnProvenance(key, parseTurnProvenance(raw)); }
`, { identifier: "cursor-protocol-fixture" });
    await module.link(async name => {
        const namespace = io.modules?.[name] ?? await import(name);
        return new vm.SyntheticModule(Object.keys(namespace), function () {
            for (const key of Object.keys(namespace)) this.setExport(key, namespace[key]);
        });
    });
    const cleanupEvents = ["exit", "beforeExit"];
    const originalListeners = cleanupEvents.map(event => new Set(process.listeners(event)));
    await module.evaluate();
    const fixtureListeners = cleanupEvents.map((event, i) => process.listeners(event).filter(listener => !originalListeners[i].has(listener)));
    const api = module.namespace, streams = [];
    function connection() {
        let destroyed = false, waiter;
        const queued = [], writes = [];
        const frames = { next() {
            io.read?.(stream);
            if (queued.length) return Promise.resolve({ done: false, value: queued.shift() });
            return destroyed ? Promise.resolve({ done: true }) : new Promise(resolve => { waiter = resolve; });
        } };
        const stream = {
            writes, isClosed: () => destroyed,
            destroy() { destroyed = true; waiter?.({ done: true }); waiter = undefined; },
            write(bytes) {
                if (destroyed) throw new Error("Fixture stream is closed");
                writes.push(api.decodeMessage("AgentClientMessage", bytes));
                return true;
            },
            frames: () => ({ [Symbol.asyncIterator]: () => frames }),
            push(value) {
                if (waiter) { const next = waiter; waiter = undefined; next({ done: false, value }); }
                else queued.push(value);
            },
        };
        streams.push(stream);
        return stream;
    }
    api.fixtureIO({ ...io, open: async (...args) => {
        const stream = connection();
        return io.open ? io.open(stream, streams.length, ...args) : stream;
    } });
    t.after(() => {
        api.sessionManager.dispose();
        for (const stream of streams) stream.destroy();
        cleanupEvents.forEach((event, i) => fixtureListeners[i].forEach(listener => process.removeListener(event, listener)));
    });
    function start(input = {}, options = {}) {
        return api.doStreamImpl("default", { getAccessToken: async () => "fixture-token", telemetryEnabled: false,
            retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }, ...options }, {
            prompt: [{ role: "user", content: [{ type: "text", text: "fixture question" }] }],
            tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
            ...input, headers: { "x-opencode-directory": encodeURIComponent("C:/virtual-fixture-workspace"), ...input.headers },
        });
    }
    return { api, streams, start };
}

export async function consume(request) {
    const { stream } = await request;
    const parts = [];
    for await (const part of stream) parts.push(part);
    return parts;
}
