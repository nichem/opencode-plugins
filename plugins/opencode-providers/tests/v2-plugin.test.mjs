import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import { Host } from "@opencode/plugin/host";
import plugin from "../src/index.js";
import { discoverModels } from "../src/providers/qoder/models.js";

function host(options = {}, key) {
    const records = [], hooks = [], integrations = new Map(), methods = [], defaults = [];
    const state = { key, resolves: 0 };
    const ctx = {
        options: { ...options, providers: typeof options.providers === "object" && !Array.isArray(options.providers)
            ? { krill: { enabled: false }, ...options.providers } : options.providers ?? { krill: { enabled: false } } },
        integration: {
            async transform(fn) {
                fn({
                    update(id, update) {
                        const entry = integrations.get(id) ?? { id, name: id };
                        update(entry);
                        integrations.set(id, entry);
                    },
                    method: { update(method) { methods.push(method); } },
                });
            },
            connection: {
                async active() { return state.key ? { type: "credential", id: "mock-connection" } : undefined; },
                async resolve() { state.resolves++; return { type: "key", key: state.key }; },
            },
        },
        provider: {
            async transform(fn) {
                fn({ add(record) {
                    // Validate against the actual installed 2.x schemas, not a handwritten shape.
                    Schema.decodeUnknownSync(Provider.Info)(record.info);
                    for (const model of record.models) Schema.decodeUnknownSync(Model.Info)(model);
                    records.push(record);
                } });
            },
        },
        model: { async transform(fn) { fn({ default: { set(...args) { defaults.push(args); } } }); } },
        aisdk: { async hook(name, run, scope) { hooks.push({ name, run, scope }); } },
    };
    return { ctx, records, hooks, integrations, methods, defaults, state };
}

async function language(h, id = "auto", sdkOptions = {}) {
    const provider = h.records[0];
    const specifier = provider.info.package.slice("aisdk:".length);
    assert.ok(specifier.startsWith("file:"));
    // Emulate the real dynamic SDK loader: import the registered URL, call create*.
    const mod = await import(specifier);
    const factory = Object.keys(mod).find(key => key.startsWith("create"));
    const sdk = mod[factory](sdkOptions);
    const model = provider.models.find(model => model.id === id);
    assert.ok(model);
    const event = { model, sdk, options: sdkOptions };
    for (const hook of h.hooks) await hook.run(event);
    return event.language ?? sdk.languageModel(model.modelID);
}

const frame = value => `data: ${JSON.stringify({ body: JSON.stringify(value) })}\n\n`;
const responseBody = frame({ choices: [{ delta: { reasoning_content: "推理" } }] })
    + frame({ choices: [{ delta: { content: "回复" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    + "data: [DONE]\n\n";

test("2.x provider schemas, file SDK, variants, commands and opt-in default", async () => {
    const entry = Host.resolve({ directory: fileURLToPath(new URL("..", import.meta.url)) });
    assert.ok(entry.server, "Local directory must resolve through OpenCode's actual loader");
    assert.equal((await Host.load(entry.server)).default, plugin);
    const h = host({ providers: { qoder: { discoverModels: false, setDefault: true } } });
    await plugin.setup(h.ctx);
    assert.equal(plugin.id, "opencode-providers");
    assert.equal(h.records[0].info.integrationID, "qoder");
    assert.equal(h.records[0].info.activation, "enabled");
    assert.deepEqual(h.defaults, [["qoder", "auto"]]);
    assert.deepEqual(h.methods.map(item => item.method.type), ["key"]);
    assert.deepEqual(h.hooks.map(hook => [hook.name, hook.scope]), [["language", { providerID: "qoder" }]]);
    const qwen = h.records[0].models.find(model => model.id === "qmodel_38max");
    assert.equal(qwen.variants.find(variant => variant.id === "xhigh").settings.reasoningEffort, "xhigh");
    assert.equal((await language(h)).specificationVersion, "v3");
    const foreign = { model: { providerID: "other", id: "auto" }, options: {} };
    await h.hooks[0].run(foreign);
    assert.equal(foreign.language, undefined);
});

test("provider disabled, custom ID, and invalid configuration", async () => {
    const disabled = host({ providers: { qoder: { enabled: false } } });
    await plugin.setup(disabled.ctx);
    assert.equal(disabled.records.length, 0);
    assert.equal(disabled.hooks.length, 0);
    const custom = host({ providers: { qoder: { providerID: "qoder-work", discoverModels: false } } });
    await plugin.setup(custom.ctx);
    assert.equal(custom.records[0].info.id, "qoder-work");
    assert.deepEqual(custom.defaults, []);
    for (const providers of [[], "invalid", { unknown: {} }, { qoder: false }]) {
        await assert.rejects(plugin.setup(host({ providers }).ctx), /opencode-providers/);
    }
});

test("2.x cached model resolves account changes and uses host fetch", async t => {
    const originalFetch = globalThis.fetch;
    const originalDebug = process.env.QODERCN_DEBUG_BODY;
    delete process.env.QODERCN_DEBUG_BODY;
    const exchanged = [];
    let chatRequests = 0;
    globalThis.fetch = async (url, request) => {
        if (String(url).endsWith("/exchange")) {
            exchanged.push(JSON.parse(request.body).personal_token);
            return Response.json({ token: "mock-job", expires_at: new Date(Date.now() + 3600000).toISOString() });
        }
        if (String(url).endsWith("/userinfo")) return Response.json({ id: "mock-user" });
        throw new Error(`Unexpected global network request: ${url}`);
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (originalDebug === undefined) delete process.env.QODERCN_DEBUG_BODY;
        else process.env.QODERCN_DEBUG_BODY = originalDebug;
    });
    const send = async (url, request) => {
        assert.ok(String(url).startsWith("https://gateway.qoder.com.cn/"));
        assert.equal(request.headers["X-Test"], "host-header");
        assert.ok(Buffer.isBuffer(request.body));
        chatRequests++;
        return new Response(responseBody);
    };
    const h = host({ providers: { qoder: { discoverModels: false } } }, "pt-v2-account-a");
    await plugin.setup(h.ctx);
    const model = await language(h, "auto", { fetch: send, headers: { "X-Test": "host-header" } });
    for (const key of ["pt-v2-account-a", "pt-v2-account-b"]) {
        h.state.key = key;
        const result = await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "你好" }] }] });
        assert.deepEqual(result.content.map(part => part.type), ["reasoning", "text"]);
        assert.equal(result.content[1].text, "回复");
        assert.equal(result.usage.inputTokens.total, 10);
    }
    assert.deepEqual(exchanged, ["pt-v2-account-a", "pt-v2-account-b"]);
    assert.equal(h.state.resolves, 2);
    assert.equal(chatRequests, 2);

    const explicit = host({ providers: { qoder: { apiKey: "pt-v2-explicit", discoverModels: false } } }, "pt-v2-connection-only");
    await plugin.setup(explicit.ctx);
    const pinned = await language(explicit, "auto", { apiKey: "pt-ignored-setting", personalAccessToken: "pt-ignored-legacy", fetch: send, headers: { "X-Test": "host-header" } });
    await pinned.doGenerate({ prompt: [] });
    assert.equal(exchanged.at(-1), "pt-v2-connection-only");
    assert.equal(explicit.state.resolves, 1);
    explicit.state.key = undefined;
    await assert.rejects(pinned.doGenerate({ prompt: [] }), /Qoder PAT not set/);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(model.doStream({ prompt: [], abortSignal: controller.signal }), { name: "AbortError" });
    assert.equal(h.state.resolves, 2);
});

test("PAT environment variables and configuration cannot replace /connect", async t => {
    const names = ["QODERCN_PERSONAL_ACCESS_TOKEN", "QODER_PAT"];
    const saved = names.map(name => process.env[name]);
    for (const name of names) process.env[name] = "pt-ignored-environment";
    t.after(() => names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
    }));
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("Unexpected network request"); };
    const h = host({ providers: { qoder: { apiKey: "pt-ignored-config" } } });
    await plugin.setup(h.ctx);
    const model = await language(h, "auto", { apiKey: "pt-ignored-setting", personalAccessToken: "pt-ignored-legacy" });
    await assert.rejects(model.doStream({ prompt: [] }), /Qoder PAT not set/);
    assert.equal(calls, 0);
});

test("live model discovery is isolated and preserves advertised model limits", async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async url => {
        if (String(url).endsWith("/exchange"))
            return Response.json({ token: "mock-job", expires_at: new Date(Date.now() + 3600000).toISOString() });
        if (String(url).endsWith("/userinfo")) return Response.json({ id: "mock-user" });
        if (String(url).endsWith("/model/list")) return Response.json({ chat: [
            { key: "custom-model", display_name: "Custom", max_input_tokens: 123456, is_reasoning: true, is_vl: true,
                thinking_config: { enabled: { efforts: { high: {} } }, disabled: true } },
            { invalid: true },
        ] });
        throw new Error(`Unexpected fetch: ${url}`);
    };
    const h = host({}, "pt-v2-discovery");
    await plugin.setup(h.ctx);
    const live = h.records[0].models.find(model => model.id === "custom-model");
    assert.equal(live.limit.context, 123456);
    assert.deepEqual(live.variants.map(variant => variant.id), ["high", "none"]);
    assert.equal((await discoverModels({ discoverModels: false })).some(model => model.id === "custom-model"), false);
    const model = await language(h, "custom-model", { fetch: async () => new Response("data: [DONE]\n\n") });
    const result = await model.doStream({ prompt: [], providerOptions: { qoder: { reasoningEffort: "none" } } });
    assert.equal(result.request.body.model_config.key, "custom-model");
    assert.equal(result.request.body.model_config.is_reasoning, true);
    assert.equal(result.request.body.parameters.enable_thinking, false);
    await Array.fromAsync(result.stream);
});
