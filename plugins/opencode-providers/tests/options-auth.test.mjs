import { CONNECTION_PAT } from "../src/providers/qoder/auth.js";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveQoderCredentials } from "../src/providers/qoder/auth.js";
import { QoderLanguageModel } from "../src/providers/qoder/language-model.js";
import { discoverModels } from "../src/providers/qoder/models.js";

const frame = chunk => `data: ${JSON.stringify({ body: JSON.stringify(chunk) })}\n\n`;
const done = "data: [DONE]\n\n";
const tools = ["run", "read"].map(name => ({ type: "function", name, inputSchema: { type: "object" } }));
const tokenResponse = () => Response.json({ token: "mock-job", expires_at: new Date(Date.now() + 3600000).toISOString() });
const stalled = signal => new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

test("request options and authentication regressions (mock network)", async t => {
    const originalFetch = globalThis.fetch;
    const originalTimeout = globalThis.setTimeout;
    const originalDebug = process.env.QODERCN_DEBUG_BODY;
    delete process.env.QODERCN_DEBUG_BODY;
    try {
        await t.test("tool choice serialization and request reasoning overrides", async () => {
            globalThis.fetch = async url => {
                if (String(url).endsWith("/exchange")) return tokenResponse();
                if (String(url).endsWith("/userinfo")) return Response.json({ id: "mock-user" });
                return new Response(done);
            };
            const model = new QoderLanguageModel("auto", { [CONNECTION_PAT]: "pt-options-test", reasoningEffort: "low" });
            for (const [choice, expected, names] of [
                [{ type: "none" }, "none", []],
                [{ type: "auto" }, "auto", ["run", "read"]],
                [{ type: "required" }, "required", ["run", "read"]],
                [{ type: "tool", toolName: "read" }, { type: "function", function: { name: "read" } }, ["read"]],
            ]) {
                const result = await model.doStream({ prompt: [], tools, toolChoice: choice, providerOptions: { qoder: { reasoningEffort: "high" } } });
                assert.deepEqual(result.request.body.tool_choice, expected);
                assert.deepEqual(result.request.body.tools.map(tool => tool.function.name), names);
                assert.equal(result.request.body.parameters.reasoning_effort, "high");
                await Array.fromAsync(result.stream);
            }
            for (const [providerOptions, effort, thinking] of [[{}, "low", true], [{ qoder: { reasoningEffort: "none" } }, "none", false], [{ qoder: { thinkingBudget: 0 } }, "none", false]]) {
                const result = await model.doStream({ prompt: [], providerOptions });
                assert.equal(result.request.body.parameters.reasoning_effort, effort);
                assert.equal(result.request.body.parameters.enable_thinking, thinking);
                await Array.fromAsync(result.stream);
            }
            await assert.rejects(model.doStream({ prompt: [], toolChoice: { type: "required" } }), /at least one/);
            await assert.rejects(model.doStream({ prompt: [], tools, toolChoice: { type: "tool", toolName: "missing" } }), /unavailable/);
        });

        await t.test("upstream cannot silently violate tool choice", async () => {
            const model = new QoderLanguageModel("auto");
            const call = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "run", arguments: "{}" } }] } }] });
            for (const [choice, body, expected] of [
                [{ type: "none" }, call + done, "error"],
                [{ type: "required" }, done, "error"],
                [{ type: "tool", toolName: "read" }, call + done, "error"],
                [{ type: "tool", toolName: "run" }, call + done, "tool-calls"],
                [{ type: "required" }, call + done, "tool-calls"],
            ]) {
                const parts = await Array.fromAsync(model.responseToStream(new Response(body), [], undefined, undefined, choice));
                assert.equal(parts.at(-1).finishReason.unified, expected);
                if (expected === "error") assert.ok(!parts.some(p => p.type === "tool-call"));
            }
        });

        await t.test("pre-aborted requests do not start authentication", async () => {
            globalThis.fetch = () => { throw new Error("unexpected fetch"); };
            const controller = new AbortController();
            controller.abort();
            await assert.rejects(new QoderLanguageModel("auto", { [CONNECTION_PAT]: "pt-preabort" }).doStream({ prompt: [], abortSignal: controller.signal }), { name: "AbortError" });
        });

        for (const stage of ["exchange", "userinfo"]) {
            await t.test(`cancelling ${stage} aborts authentication and allows retry`, async () => {
                let signal;
                let entered;
                const ready = new Promise(resolve => { entered = resolve; });
                globalThis.fetch = async (url, options) => {
                    if (stage === "userinfo" && String(url).endsWith("/exchange")) return tokenResponse();
                    signal = options.signal;
                    entered();
                    return stalled(signal);
                };
                const controller = new AbortController();
                const options = { [CONNECTION_PAT]: `pt-abort-${stage}` };
                const promise = resolveQoderCredentials(options, controller.signal);
                const rejected = assert.rejects(promise, { name: "AbortError" });
                await ready;
                controller.abort();
                await rejected;
                assert.equal(signal.aborted, true);
                globalThis.fetch = async url => String(url).endsWith("/exchange") ? tokenResponse() : Response.json({ id: "mock-user" });
                assert.equal((await resolveQoderCredentials(options)).access, "mock-job");
            });
        }

        await t.test("concurrent authentication shares exchange without cross-cancellation", async () => {
            let release, signal, count = 0;
            globalThis.fetch = async (url, options) => {
                if (String(url).endsWith("/exchange")) {
                    count++;
                    signal = options.signal;
                    return new Promise(resolve => { release = () => resolve(tokenResponse()); });
                }
                return Response.json({ id: "mock-user" });
            };
            const controller = new AbortController();
            const options = { [CONNECTION_PAT]: "pt-concurrent" };
            const first = resolveQoderCredentials(options, controller.signal);
            const second = resolveQoderCredentials(options);
            const rejected = assert.rejects(first, { name: "AbortError" });
            controller.abort();
            await rejected;
            assert.equal(signal.aborted, false);
            release();
            assert.equal((await second).access, "mock-job");
            assert.equal((await resolveQoderCredentials(options)).access, "mock-job");
            assert.equal(count, 1);
        });

        for (const stage of ["exchange", "userinfo"]) {
            await t.test(`authentication has a bounded timeout during ${stage}`, async () => {
                let signal;
                globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 15000 ? 15 : ms, ...args);
                globalThis.fetch = async (url, options) => {
                    if (stage === "userinfo" && String(url).endsWith("/exchange")) return tokenResponse();
                    signal = options.signal;
                    return stalled(signal);
                };
                await assert.rejects(resolveQoderCredentials({ [CONNECTION_PAT]: `pt-timeout-${stage}` }), { name: "TimeoutError" });
                assert.equal(signal.aborted, true);
                globalThis.setTimeout = originalTimeout;
            });
        }

        await t.test("model discovery's six-second deadline also covers authentication", async () => {
            let signal;
            globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 6000 ? 15 : ms, ...args);
            globalThis.fetch = async (_, options) => { signal = options.signal; return stalled(signal); };
            const models = await discoverModels({ [CONNECTION_PAT]: "pt-model-discovery" });
            assert.equal(signal.aborted, true);
            assert.ok(models.some(model => model.id === "auto"));
            globalThis.setTimeout = originalTimeout;
        });
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.setTimeout = originalTimeout;
        if (originalDebug === undefined) delete process.env.QODERCN_DEBUG_BODY;
        else process.env.QODERCN_DEBUG_BODY = originalDebug;
    }
});
