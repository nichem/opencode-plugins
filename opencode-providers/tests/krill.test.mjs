import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "effect";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import plugin from "../src/index.js";
import { discoverModels, validateOptions } from "../src/providers/krill/models.js";

function host() {
    const state = { key: "fake-krill-a", hooks: [], records: [], methods: [] };
    const ctx = { options: { providers: { qoder: { enabled: false }, cursor: { enabled: false }, krill: { discoverModels: false } } },
        integration: {
            transform: async fn => fn({ update: (id, update) => update({ id }), method: { update: value => state.methods.push(value) } }),
            connection: { active: async id => { assert.equal(id, "krill"); return state.key ? { type: "credential" } : undefined; },
                resolve: async () => ({ type: "key", key: state.key }) },
        },
        aisdk: { hook: async (name, run, scope) => state.hooks.push({ name, run, scope }) },
        provider: { transform: async fn => fn({ add(record) {
            Schema.decodeUnknownSync(Provider.Info)(record.info);
            record.models.forEach(model => Schema.decodeUnknownSync(Model.Info)(model));
            state.records.push(record);
        } }) },
    };
    return { ctx, state };
}

export const response = { id: "resp_test", object: "response", created_at: 1, model: "gpt-6.1-sol", status: "completed",
    output: [{ id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };

test("Krill registers an independent /connect integration and native 2.x models", async () => {
    const { ctx, state } = host();
    await plugin.setup(ctx);
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].info.integrationID, "krill");
    assert.equal(state.records[0].info.package, "aisdk:@ai-sdk/openai");
    assert.equal(state.records[0].models[1].limit.context, 272000);
    assert.equal(state.records[0].models[1].limit.output, 128000);
    assert.deepEqual(state.records[0].models[1].variants.map(x => x.id), ["low", "medium", "high", "xhigh"]);
    assert.equal(state.methods[0].method.label, "Krill API Key");
    const foreign = { model: { providerID: "qoder" } };
    for (const hook of state.hooks) { assert.equal(hook.scope.providerID, "krill"); await hook.run(foreign); }
    assert.equal(foreign.sdk, undefined);
    assert.equal(foreign.language, undefined);
});

test("real OpenAI SDK uses Responses, host fetch and the current connected key", async () => {
    const { ctx, state } = host();
    await plugin.setup(ctx);
    const requests = [];
    const event = { model: state.records[0].models[1], options: { apiKey: "ignored-config-key", headers: { "X-Test": "host" },
        fetch: async (url, init) => { requests.push({ url, init, body: JSON.parse(init.body) }); return Response.json(response); } } };
    for (const hook of state.hooks) await hook.run(event);
    const input = { prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        providerOptions: { openai: { reasoningEffort: "high", reasoningSummary: "auto", store: false, textVerbosity: "low" } } };
    for (const key of ["fake-krill-a", "fake-krill-b"]) {
        state.key = key;
        assert.equal((await event.language.doGenerate(input)).content[0].text, "ok");
        const last = requests.at(-1);
        assert.equal(String(last.url), "https://api.krill-code.net/codex/v1/responses");
        assert.equal(last.init.headers.get("authorization"), `Bearer ${key}`);
        assert.equal(last.init.headers.get("x-test"), "host");
        assert.equal(last.body.store, false);
        assert.equal(last.body.reasoning.effort, "high");
        assert.equal(last.body.text.verbosity, "low");
    }
    state.key = undefined;
    await assert.rejects(event.language.doGenerate(input), /Krill API Key not set/);
    assert.equal(requests.length, 2);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(event.language.doStream({ ...input, abortSignal: abort.signal }), { name: "AbortError" });
});

test("discovery filters incompatible series and allows explicit model metadata", async () => {
    const models = await discoverModels("krill", { models: { "gpt-6.1-sol": { contextWindow: 500000, maxTokens: 64000, input: ["text", "image"] } } },
        async () => "fake-key", async (url, init) => {
            assert.equal(init.headers.Authorization, "Bearer fake-key");
            assert.match(url, /\/models$/);
            return Response.json({ data: ["gpt-6-sol", "claude-opus-test", "gpt-image-2", "gpt-4-audio", null].map(id => ({ id })) });
        });
    assert.deepEqual(models.map(x => x.id), ["gpt-5.6-sol", "gpt-6.1-sol", "gpt-6-sol"]);
    assert.equal(models[1].limit.context, 500000);
    assert.deepEqual(models[1].capabilities.input, ["text", "image"]);
    const fallback = await discoverModels("krill", {}, async () => { throw new Error("offline"); });
    assert.equal(fallback.length, 2);
    for (const options of [{ models: null }, { models: { x: { maxTokens: -1 } } }, { baseURL: "http://example.com/v1" }, { baseURL: "https://name:secret@example.com" }]) {
        assert.throws(() => validateOptions(options));
    }
});
