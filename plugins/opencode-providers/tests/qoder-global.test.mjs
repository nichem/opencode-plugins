import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { Schema } from "effect";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import plugin from "../src/index.js";
import { CONNECTION_PAT, resolveQoderCredentials } from "../src/providers/qoder/auth.js";
import { discoverModels } from "../src/providers/qoder/models.js";
import { modelInfo } from "../src/providers/qoder/index.js";
import { getMachineId } from "../src/providers/qoder/cosy.js";
import { QODER_GLOBAL } from "../src/providers/qoder-global/constants.js";

function host(providers = {}, keys = {}) {
    const records = [], hooks = [], methods = [], defaults = [], integrations = new Map();
    const state = { keys, resolved: [] };
    const ctx = {
        options: { providers },
        integration: {
            transform: async fn => fn({
                update(id, update) { const entry = { id }; update(entry); integrations.set(id, entry); },
                method: { update(value) { methods.push(value); } },
            }),
            connection: {
                async active(id) { return state.keys[id] ? { type: "credential", id } : undefined; },
                async resolve(connection) {
                    state.resolved.push(connection.id);
                    return { type: "key", key: state.keys[connection.id] };
                },
            },
        },
        provider: { transform: async fn => fn({ add(record) {
            Schema.decodeUnknownSync(Provider.Info)(record.info);
            record.models.forEach(model => Schema.decodeUnknownSync(Model.Info)(model));
            records.push(record);
        } }) },
        aisdk: { hook: async (name, run, scope) => hooks.push({ name, run, scope }) },
        model: { transform: async fn => fn({ default: { set: (...args) => defaults.push(args) } }) },
    };
    return { ctx, records, hooks, methods, defaults, integrations, state };
}

async function language(h, providerID, modelID = "auto", options = {}) {
    const record = h.records.find(record => record.info.id === providerID);
    const mod = await import(record.info.package.slice("aisdk:".length));
    const factory = Object.keys(mod).find(name => name.startsWith("create"));
    const sdk = mod[factory](options);
    assert.equal(sdk.languageModel(modelID).provider, providerID);
    const event = { model: record.models.find(model => model.id === modelID), sdk, options };
    for (const hook of h.hooks) await hook.run(event);
    return event.language;
}

const offline = { qoder: { discoverModels: false }, krill: { discoverModels: false }, "qoder-global": { discoverModels: false } };
const done = "data: [DONE]\n\n";

test("Qoder Global registration, authentication and discovery are region-isolated", async t => {
    // Keep device IDs and all fake credentials away from the user's real home.
    const root = mkdtempSync(join(os.tmpdir(), "opencode-qoder-global-test-"));
    const homeMock = t.mock.method(os, "homedir", () => root);
    syncBuiltinESMExports();
    const originalFetch = globalThis.fetch;
    const originalDebug = process.env.QODERCN_DEBUG_BODY;
    delete process.env.QODERCN_DEBUG_BODY;
    t.after(() => {
        globalThis.fetch = originalFetch;
        if (originalDebug === undefined) delete process.env.QODERCN_DEBUG_BODY;
        else process.env.QODERCN_DEBUG_BODY = originalDebug;
        homeMock.mock.restore();
        syncBuiltinESMExports();
        rmSync(root, { recursive: true, force: true });
    });

    await t.test("all three providers coexist; the global SDK and hooks stay scoped", async () => {
        globalThis.fetch = async () => assert.fail("Disconnected registration must not access the network");
        const h = host();
        await plugin.setup(h.ctx);
        assert.deepEqual(h.records.map(record => record.info.id), ["qoder", "krill", "qoder-global"]);
        assert.deepEqual(h.defaults, []);
        assert.equal(h.integrations.get("qoder").name, "Qoder CN");
        assert.equal(h.integrations.get("qoder-global").name, "Qoder Global");
        assert.equal(h.methods.find(method => method.integrationID === "qoder-global").method.label, "Qoder Global Personal Access Token");
        assert.deepEqual(h.records[0].models.map(model => model.id), ["auto", "qmodel_38max"]);
        const global = h.records.find(record => record.info.id === "qoder-global");
        assert.deepEqual(global.models.map(model => model.id), ["auto"]);
        assert.equal(global.models[0].limit.context, 180000);
        assert.notEqual(global.info.package, h.records[0].info.package);
        const model = await language(h, "qoder-global");
        assert.equal(model.specificationVersion, "v3");
        await assert.rejects(model.doStream({ prompt: [] }), /select Qoder Global/);
        const globalHook = h.hooks.find(hook => hook.scope.providerID === "qoder-global");
        for (const providerID of ["qoder", "krill", "other"]) {
            const foreign = { model: { providerID, id: "auto" }, options: {} };
            await globalHook.run(foreign);
            assert.equal(foreign.language, undefined);
        }
    });

    await t.test("the global provider can be disabled or use a custom ID and default", async () => {
        const disabled = host({ ...offline, "qoder-global": { enabled: false } });
        await plugin.setup(disabled.ctx);
        assert.deepEqual(disabled.records.map(record => record.info.id), ["qoder", "krill"]);
        const custom = host({ qoder: { enabled: false }, krill: { enabled: false },
            "qoder-global": { providerID: "qoder-international", discoverModels: false, setDefault: true } });
        await plugin.setup(custom.ctx);
        assert.equal(custom.records[0].info.integrationID, "qoder-international");
        assert.deepEqual(custom.defaults, [["qoder-international", "auto"]]);
        assert.deepEqual(custom.hooks.map(hook => hook.scope), [{ providerID: "qoder-international" }]);
    });

    await t.test("device IDs do not read the CN identity for Global", () => {
        mkdirSync(join(root, ".qoder-cn", ".auth"), { recursive: true });
        writeFileSync(join(root, ".qoder-cn", ".auth", "machine_id"), "mock-cn-device");
        assert.equal(getMachineId(), "mock-cn-device");
        const global = getMachineId("global");
        assert.notEqual(global, "mock-cn-device");
        assert.equal(getMachineId("global"), global);
        mkdirSync(join(root, ".qoder", ".auth"), { recursive: true });
        writeFileSync(join(root, ".qoder", ".auth", "machine_id"), "mock-global-device");
        assert.equal(getMachineId("global"), "mock-global-device");
        assert.equal(getMachineId(), "mock-cn-device");
    });

    await t.test("same PAT in both regions never shares pending requests or cached tokens", async () => {
        const exchanges = [], chats = [];
        globalThis.fetch = async (url, init) => {
            const hostname = new URL(url).hostname;
            assert.ok(["openapi.qoder.sh", "openapi.qoder.com.cn"].includes(hostname));
            const region = hostname.endsWith(".sh") ? "global" : "cn";
            if (url.endsWith("/exchange")) {
                exchanges.push({ region, pat: JSON.parse(init.body).personal_token });
                assert.equal(init.headers["Cosy-MachineId"], `mock-${region}-device`);
                return Response.json({ token: `job-${region}`, expires_at: new Date(Date.now() + 3600000).toISOString() });
            }
            assert.ok(url.endsWith("/userinfo"));
            assert.equal(init.headers.Authorization, `Bearer job-${region}`);
            return Response.json({ id: `user-${region}` });
        };
        const send = async (url, init) => {
            const region = new URL(url).hostname === "api3.qoder.sh" ? "global" : "cn";
            assert.equal(new URL(url).hostname, region === "global" ? "api3.qoder.sh" : "gateway.qoder.com.cn");
            assert.equal(init.headers["Cosy-User"], `user-${region}`);
            assert.equal(init.headers["Cosy-Machineid"], `mock-${region}-device`);
            assert.equal(init.headers["X-Test"], "host");
            chats.push(region);
            return new Response(done);
        };
        const h = host(offline, { qoder: "pt-fixture-shared", "qoder-global": "pt-fixture-shared" });
        await plugin.setup(h.ctx);
        const cn = await language(h, "qoder", "auto", { fetch: send, headers: { "X-Test": "host" } });
        const global = await language(h, "qoder-global", "auto", { fetch: send, headers: { "X-Test": "host" },
            apiKey: "pt-ignored", region: "cn", baseURL: "https://ignored.invalid" });
        await Promise.all([cn.doGenerate({ prompt: [] }), global.doGenerate({ prompt: [] })]);
        assert.deepEqual(exchanges.map(entry => entry.region).sort(), ["cn", "global"]);
        await Promise.all([cn.doGenerate({ prompt: [] }), global.doGenerate({ prompt: [] })]);
        assert.equal(exchanges.length, 2);
        h.state.keys["qoder-global"] = "pt-fixture-global-switched";
        await global.doGenerate({ prompt: [] });
        await cn.doGenerate({ prompt: [] });
        assert.deepEqual(exchanges.at(-1), { region: "global", pat: "pt-fixture-global-switched" });
        assert.equal(exchanges.length, 3);
        assert.equal(chats.length, 6);
        delete h.state.keys["qoder-global"];
        await assert.rejects(global.doGenerate({ prompt: [] }), /select Qoder Global/);
        assert.equal(chats.length, 6);
    });

    await t.test("discover advertised models and send their IDs, capabilities and variants", async () => {
        const requests = [];
        globalThis.fetch = async (url, init) => {
            requests.push(url);
            if (url.endsWith("/exchange")) return Response.json({ token: "mock-discovery", expires_in: 3600 });
            if (url.endsWith("/userinfo")) return Response.json({ id: "mock-global" });
            assert.equal(url, QODER_GLOBAL.modelListURL);
            assert.equal(init.headers["Cosy-User"], "mock-global");
            // Fictional ID and capabilities: this does not assert live Qoduck availability.
            return Response.json({ chat: [{ key: "fixture-qoduck", display_name: "Qoduck", price_factor: 0, original_price_factor: 0.5, is_reasoning: true,
                is_vl: true, max_input_tokens: 123456, thinking_config: { enabled: { efforts: { high: {}, xhigh: {} } }, disabled: true } }] });
        };
        const h = host({ qoder: { discoverModels: false }, krill: { enabled: false } }, { "qoder-global": "pt-fixture-discovery" });
        await plugin.setup(h.ctx);
        assert.ok(requests.every(url => new URL(url).hostname.endsWith(".qoder.sh")));
        assert.equal(h.records[0].models.some(model => model.id === "fixture-qoduck"), false);
        const model = h.records[1].models.find(model => model.id === "fixture-qoduck");
        assert.equal(model.name, "Qoduck · 0×（原 0.5×）");
        assert.equal(model.modelID, "fixture-qoduck");
        assert.equal(model.limit.context, 123456);
        assert.deepEqual(model.capabilities.input, ["text", "image"]);
        assert.deepEqual(model.variants.map(variant => variant.id), ["high", "xhigh", "none"]);
        const live = await language(h, "qoder-global", "fixture-qoduck", { fetch: async (url, init) => {
            assert.equal(url, QODER_GLOBAL.chatURL);
            assert.equal(init.headers["X-Model-Key"], "fixture-qoduck");
            return new Response(done);
        } });
        const result = await live.doStream({ prompt: [], providerOptions: {
            qoder: { reasoningEffort: "low" }, "qoder-global": { reasoningEffort: "xhigh" },
        } });
        assert.equal(result.request.body.model_config.key, "fixture-qoduck");
        assert.equal(result.request.body.model_config.is_reasoning, true);
        assert.equal(result.request.body.parameters.reasoning_effort, "xhigh");
        const chunks = await Array.fromAsync(result.stream);
        assert.deepEqual(chunks.at(-1).providerMetadata, { "qoder-global": {} });
    });

    await t.test("credit multipliers preserve zero, reject invalid values and refresh without stale prices", async () => {
        let list = [
            { key: "auto", display_name: "Auto", price_factor: 0.5, original_price_factor: 1 },
            { key: "free", display_name: "Free fixture", price_factor: 0, original_price_factor: "0.5" },
            { key: "same", price_factor: "0.50", original_price_factor: 0.5 },
            { key: "original-only", original_price_factor: 2 },
            ...[undefined, null, false, true, "", " ", "free", "0.5x", "Infinity", -1, [], {}].map((value, i) =>
                ({ key: `invalid-${i}`, price_factor: value, original_price_factor: value, is_free: true })),
        ];
        const calls = [];
        globalThis.fetch = async url => {
            calls.push(url);
            if (url.endsWith("/exchange")) return Response.json({ token: "mock-pricing", expires_in: 3600 });
            if (url.endsWith("/userinfo")) return Response.json({ id: "mock-pricing-user" });
            assert.equal(url, QODER_GLOBAL.modelListURL);
            return Response.json({ models: list });
        };
        const options = { [CONNECTION_PAT]: "pt-fixture-pricing" };
        const models = await discoverModels(options, QODER_GLOBAL);
        assert.equal(calls.length, 3, "Pricing comes from the existing catalog request");
        const byID = new Map(models.map(model => [model.id, model]));
        assert.equal(byID.get("free").priceFactor, 0);
        assert.equal(byID.get("free").originalPriceFactor, 0.5);
        const records = models.map(model => modelInfo("qoder-global", model));
        assert.deepEqual(records.slice(0, 4).map(model => model.name), [
            "Auto · 0.5×（原 1×）", "Free fixture · 0×（原 0.5×）", "same · 0.5×", "original-only",
        ]);
        for (const model of models.filter(model => model.id.startsWith("invalid-"))) {
            assert.equal(model.priceFactor, undefined);
            assert.equal(model.originalPriceFactor, undefined);
            assert.equal(modelInfo("qoder-global", model).name, model.id);
        }
        for (const record of records) {
            Schema.decodeUnknownSync(Model.Info)(record);
            assert.equal(record.modelID, record.id);
            assert.deepEqual(record.cost, [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]);
        }
        list = [{ key: "auto", display_name: "Auto" }];
        const refreshed = await discoverModels(options, QODER_GLOBAL);
        assert.equal(modelInfo("qoder-global", refreshed[0]).name, "Auto");
        assert.equal(refreshed[0].priceFactor, undefined);
        assert.equal(calls.length, 4);
        const offlineModels = await discoverModels({ discoverModels: false }, QODER_GLOBAL);
        assert.equal(modelInfo("qoder-global", offlineModels[0]).name, "Qoder Global Auto");
    });

    await t.test("failed or disabled discovery keeps only the global fallback", async () => {
        globalThis.fetch = async () => assert.fail("Discovery is disabled");
        const disabled = await discoverModels({ discoverModels: false, [CONNECTION_PAT]: "pt-fixture-disabled" }, QODER_GLOBAL);
        assert.deepEqual(disabled.map(model => model.id), ["auto"]);
        globalThis.fetch = async () => new Response("denied", { status: 403 });
        const failed = await discoverModels({ [CONNECTION_PAT]: "pt-fixture-denied" }, QODER_GLOBAL);
        assert.deepEqual(failed.map(model => model.id), ["auto"]);
        const originalTimeout = globalThis.setTimeout;
        const timeout = t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) =>
            originalTimeout(fn, ms === 6000 ? 10 : ms, ...args));
        let signal;
        globalThis.fetch = async (_, init) => {
            signal = init.signal;
            return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        };
        try {
            assert.deepEqual((await discoverModels({ [CONNECTION_PAT]: "pt-fixture-timeout" }, QODER_GLOBAL)).map(model => model.id), ["auto"]);
            assert.equal(signal.aborted, true);
        } finally { timeout.mock.restore(); }
    });

    await t.test("configuration and environment cannot supply a global PAT", async () => {
        globalThis.fetch = async () => assert.fail("Missing connection must not make a request");
        const saved = process.env.QODER_PERSONAL_ACCESS_TOKEN;
        process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-ignored-env";
        try {
            const h = host({ ...offline, "qoder-global": { apiKey: "pt-ignored-config" } }, { qoder: "pt-other-region" });
            await plugin.setup(h.ctx);
            const global = await language(h, "qoder-global", "auto", { apiKey: "pt-ignored-sdk", personalAccessToken: "pt-ignored-legacy" });
            await assert.rejects(global.doStream({ prompt: [] }), /select Qoder Global/);
            assert.deepEqual(h.state.resolved, []);
            await assert.rejects(resolveQoderCredentials({ [CONNECTION_PAT]: "invalid" }, undefined, QODER_GLOBAL), /Qoder Global only supports/);
        } finally {
            if (saved === undefined) delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
            else process.env.QODER_PERSONAL_ACCESS_TOKEN = saved;
        }
    });
});
