import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { callAPI, validate } from "../src/api.js";

async function fixture(work) {
    const root = await mkdtemp(join(tmpdir(), "deepseek-skills-api-"));
    const calls = [], permissions = [];
    const options = { key: "fixture-secret", signal: new AbortController().signal, directory: root,
        permit: async (action, resource) => { permissions.push({ action, resource }); },
        transport: async (url, request) => { calls.push({ url, request }); return Response.json({}); } };
    try { await work({ root, calls, permissions, options }); }
    finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); }
}

test("Search preserves independent API options and Fetch returns Markdown", async () => fixture(async ({ options, calls }) => {
    options.transport = async (url, request) => { calls.push({ url, request }); return Response.json(url.endsWith("search")
        ? { results: [{ title: "fixture", url: "https://example.invalid", content: "body" }] } : { title: "fixture", content: "# Body" }); };
    const found = await callAPI("search", { query: "😀".repeat(128), count: 50, need_content: true }, options);
    assert.equal(found.result.results.length, 1);
    assert.equal(JSON.parse(calls[0].request.body).need_content, true);
    assert.equal(calls[0].request.headers.Authorization, "Bearer fixture-secret");
    assert.equal(calls[0].request.redirect, "error");
    assert.equal((await callAPI("fetch", { url: "https://example.invalid" }, options)).result.content, "# Body");
    assert.throws(() => validate("search", { query: "x".repeat(129) }), /128/);
    assert.throws(() => validate("fetch", { url: "https://user:pass@example.invalid" }), /无用户名/);
    assert.throws(() => validate("fetch", { url: "file:///fixture" }), /HTTP/);
}));

test("OCR and ASR upload files with correct forms; OCR checks errors inside HTTP 200", async () => fixture(async ({ root, options, permissions }) => {
    await writeFile(join(root, "fixture.pdf"), "%PDF-fixture");
    await writeFile(join(root, "fixture.wav"), "RIFF0000WAVEfixture");
    options.transport = async (url, request) => {
        assert.ok(request.body instanceof FormData);
        assert.equal(request.body.get("file").name, url.endsWith("ocr") ? "fixture.pdf" : "fixture.wav");
        if (url.endsWith("ocr")) { assert.equal(request.body.get("purpose"), "rich_layout_recognition");
            return new Response('\n\n{"pages":[{"index":0,"text":"fixture","finish_reason":"length"}]}'); }
        return Response.json({ text: "fixture transcript", duration_ms: 200 });
    };
    const ocr = await callAPI("ocr", { file: "fixture.pdf", purpose: "rich_layout_recognition" }, options);
    assert.equal(ocr.result.pages[0].finish_reason, "length");
    assert.equal((await callAPI("asr", { file: "fixture.wav" }, options)).result.text, "fixture transcript");
    assert.equal(permissions.filter(p => p.action === "read").length, 2);
    options.transport = async () => Response.json({ error: { message: "fixture-secret" } });
    await assert.rejects(callAPI("ocr", { file: "fixture.pdf" }, options), error => /处理失败/.test(error.message) && !error.message.includes("fixture-secret"));
}));

test("TTS saves a new audio file; collision and permission refusal prevent network requests", async () => fixture(async ({ root, options }) => {
    let count = 0;
    const audio = Buffer.from("RIFF0000WAVEfixture");
    options.transport = async () => { count++; return new Response(audio, { headers: { "content-type": "audio/wav" } }); };
    const result = await callAPI("tts", { text: "fixture", output_file: "speech.wav" }, options);
    assert.deepEqual(await readFile(result.file), audio);
    await assert.rejects(callAPI("tts", { text: "fixture", output_file: "speech.wav" }, options), /已存在/);
    assert.equal(count, 1);
    const rejection = new Error("fixture permission rejected");
    options.permit = async () => { throw rejection; };
    await assert.rejects(callAPI("search", { query: "fixture" }, options), error => error === rejection);
    assert.equal(count, 1);
    assert.throws(() => validate("tts", { text: "汉".repeat(5001), output_file: "x.wav" }), /计费字符/);
}));

test("large text is saved in full with an explicit truncated preview", async () => fixture(async ({ options }) => {
    options.transport = async () => Response.json({ title: "fixture", content: "a".repeat(25000) });
    const result = await callAPI("fetch", { url: "https://example.invalid", output_file: "page.json" }, options);
    assert.equal(result.truncated, true);
    assert.equal(JSON.parse(await readFile(result.file, "utf8")).content.length, 25000);
}));

test("HTTP errors, malformed responses and aborted audio do not reveal credentials or leave files", async () => fixture(async ({ root, options }) => {
    for (const status of [401, 402, 429, 500]) {
        options.transport = async () => new Response("fixture-secret", { status });
        await assert.rejects(callAPI("search", { query: "fixture" }, options), error => !error.message.includes("fixture-secret"));
    }
    options.transport = async () => new Response("fixture-secret");
    await assert.rejects(callAPI("search", { query: "fixture" }, options), /JSON/);
    options.transport = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("fixture-secret")); } }),
        { headers: { "content-type": "audio/wav" } });
    await assert.rejects(callAPI("tts", { text: "fixture", output_file: "failed.wav" }, options), /读取失败/);
    await assert.rejects(stat(join(root, "failed.wav")), { code: "ENOENT" });
    const controller = new AbortController(); controller.abort(); options.signal = controller.signal;
    let called = false; options.transport = async () => { called = true; };
    await assert.rejects(callAPI("search", { query: "fixture" }, options));
    assert.equal(called, false);
}));
