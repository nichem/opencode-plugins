import { readFile, stat, realpath, open, unlink } from "node:fs/promises";
import { basename, dirname, resolve, extname } from "node:path";

const BASE = "https://api.deepseek.com/v1/tools/";
const MiB = 1024 * 1024;
export class APIError extends Error {}
const fail = message => { throw new APIError(message); };
function text(value, name, max) {
    if (typeof value !== "string" || !value.trim() || [...value].length > max) fail(`${name} 必须为 1～${max} 个字符`);
    return value;
}
function choice(value, choices, fallback, name) {
    if (value === undefined) return fallback;
    if (!choices.includes(value)) fail(`${name} 必须是 ${choices.join(" / ")}`);
    return value;
}
function bool(value, fallback, name) {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") fail(`${name} 必须是布尔值`);
    return value;
}
export function validate(skill, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("input 必须为对象");
    const fields = {
        search: ["query", "count", "ori_question", "localization", "need_content", "output_file"],
        fetch: ["url", "output_file"], ocr: ["file", "purpose", "output_file"],
        asr: ["file", "output_file"], tts: ["text", "voice_id", "format", "filter_markdown", "output_file"],
    }[skill];
    if (!fields) fail("未知 DeepSeek 技能");
    if (Object.keys(input).some(key => !fields.includes(key))) fail(`仅支持参数：${fields.join(", ")}`);
    if (input.output_file !== undefined) text(input.output_file, "output_file", 8192);
    if (skill === "search") {
        const body = { query: text(input.query, "query", 128), count: input.count ?? 10,
            need_content: bool(input.need_content, false, "need_content") };
        if (!Number.isInteger(body.count) || body.count < 1 || body.count > 50) fail("count 必须为 1～50 的整数");
        if (input.ori_question !== undefined) body.ori_question = text(input.ori_question, "ori_question", 128);
        if (input.localization !== undefined) body.localization = text(input.localization, "localization", 128);
        return body;
    }
    if (skill === "fetch") {
        const url = text(input.url, "url", 8192);
        let parsed;
        try { parsed = new URL(url); } catch { fail("url 必须是完整的 HTTP/HTTPS 地址"); }
        if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password)
            fail("url 必须是无用户名和密码的 HTTP/HTTPS 地址");
        return { url };
    }
    if (skill === "ocr" || skill === "asr") return { file: text(input.file, "file", 8192), ...(skill === "ocr"
        ? { purpose: choice(input.purpose, ["text_recognition", "rich_layout_recognition"], "text_recognition", "purpose") } : {}) };
    const body = { text: text(input.text, "text", 10000),
        voice_id: choice(input.voice_id, ["stella", "tide"], "stella", "voice_id"),
        format: choice(input.format, ["wav", "pcm"], "wav", "format"),
        filter_markdown: bool(input.filter_markdown, true, "filter_markdown") };
    if ([...body.text].reduce((sum, c) => sum + (/\p{Script=Han}/u.test(c) ? 2 : 1), 0) > 10000)
        fail("text 超过 10,000 个计费字符（汉字按 2 个字符）");
    if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024) fail("TTS 请求超过 64 KiB");
    text(input.output_file, "output_file", 8192);
    if (extname(input.output_file).toLowerCase() !== `.${body.format}`) fail(`output_file 必须以 .${body.format} 结尾`);
    return body;
}

async function bytes(response, limit, signal) {
    if (!response.body) fail("DeepSeek 响应为空");
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
        for (;;) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > limit) fail("DeepSeek 响应超过大小限制");
            chunks.push(value);
        }
    } finally { await reader.cancel().catch(() => {}); }
    signal.throwIfAborted();
    return Buffer.concat(chunks);
}

async function outputPath(path, directory, permit) {
    const candidate = resolve(directory, path);
    let parent;
    try { parent = await realpath(dirname(candidate)); } catch { fail("输出目录不存在，请先创建目录"); }
    const target = resolve(parent, basename(candidate));
    await permit("edit", target);
    return target;
}

async function writeNew(path, content, signal) {
    let handle;
    try { handle = await open(path, "wx", 0o600); }
    catch (error) { fail(error.code === "EEXIST" ? "输出文件已存在，请选择新文件名" : "无法创建输出文件"); }
    try {
        signal.throwIfAborted();
        await handle.writeFile(content, { signal });
        signal.throwIfAborted();
    } catch (error) {
        await handle.close();
        await unlink(path).catch(() => {});
        throw error;
    }
    await handle.close();
}

export async function callAPI(skill, input, { key, signal: requestSignal, directory, permit,
    transport = (...args) => globalThis.fetch(...args) }) {
    const body = validate(skill, input);
    const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(skill === "tts" ? 32 * 60 * 1000
        : skill === "ocr" ? 200000 : skill === "asr" ? 660000 : 60000)]);
    signal.throwIfAborted();
    let payload, headers = { Authorization: `Bearer ${key}` };
    await permit(`deepseek-${skill}`, skill === "fetch" ? body.url : skill);
    const target = input.output_file ? await outputPath(input.output_file, directory, permit) : undefined;
    // Check output collision before an API request can incur a charge. writeNew also uses exclusive creation.
    if (target) {
        try { await stat(target); fail("输出文件已存在，请选择新文件名"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (skill === "ocr" || skill === "asr") {
        let file;
        try { file = await realpath(resolve(directory, body.file)); } catch { fail("输入文件不存在或无法访问"); }
        await permit("read", file);
        const info = await stat(file);
        if (!info.isFile() || info.size === 0 || info.size > (skill === "ocr" ? 100 : 8) * MiB)
            fail(`${skill.toUpperCase()} 需要非空文件，最大 ${skill === "ocr" ? 100 : 8} MiB`);
        const content = await readFile(file, { signal });
        if (content.length > (skill === "ocr" ? 100 : 8) * MiB) fail("输入文件在读取时超过大小限制");
        if (skill === "asr" && !(content.subarray(0, 4).toString() === "OggS"
            || (content.subarray(0, 4).toString() === "RIFF" && content.subarray(8, 12).toString() === "WAVE")))
            fail("ASR 只接受 16 位 PCM WAV 或 Ogg Opus，最长 120 秒");
        payload = new FormData();
        payload.set("file", new Blob([content]), basename(file));
        if (skill === "ocr") payload.set("purpose", body.purpose);
    } else { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    // Permission prompts can be long; check again immediately before network access.
    signal.throwIfAborted();
    let value;
    try {
        const response = await transport(BASE + skill, { method: "POST", headers, body: payload, signal, redirect: "error" });
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            fail(response.status === 401 ? "DSS 凭据无效，请通过 /connect 检查连接"
                : response.status === 402 ? "DeepSeek 余额不足"
                : response.status === 429 ? "DeepSeek 请求限流，请稍后重试"
                : `DeepSeek ${skill.toUpperCase()} 请求失败（HTTP ${response.status}）`);
        }
        if (skill === "tts") {
            const mime = response.headers.get("content-type")?.split(";")[0];
            if (!(body.format === "wav" ? ["audio/wav", "audio/x-wav"] : ["audio/pcm", "application/octet-stream"]).includes(mime)) {
                await response.body?.cancel().catch(() => {});
                fail("DeepSeek TTS 未返回预期音频格式");
            }
            const audio = await bytes(response, 100 * MiB, signal);
            if (!audio.length || (body.format === "wav" && (audio.subarray(0, 4).toString() !== "RIFF"
                || audio.subarray(8, 12).toString() !== "WAVE"))) fail("DeepSeek TTS 返回的音频无效");
            await writeNew(target, audio, signal);
            return { file: target, format: body.format, bytes: audio.length };
        }
        const raw = await bytes(response, 32 * MiB, signal);
        try { value = JSON.parse(raw.toString("utf8")); } catch { fail("DeepSeek 返回了无效的 JSON"); }
        // OCR may report an error inside HTTP 200 after starting recognition.
        if (!value || value.error) fail(`DeepSeek ${skill.toUpperCase()} 处理失败，请检查输入或稍后重试`);
        if (skill === "search" && !Array.isArray(value.results)
            || skill === "fetch" && typeof value.content !== "string"
            || skill === "ocr" && !Array.isArray(value.pages)
            || skill === "asr" && typeof value.text !== "string") fail("DeepSeek 返回的结果格式无效");
    } catch (error) {
        if (requestSignal.aborted) throw new APIError("DeepSeek 操作已取消");
        if (signal.aborted) throw new APIError("DeepSeek 请求超时，未自动重试");
        if (error instanceof APIError) throw error;
        throw new APIError("DeepSeek 网络或响应读取失败，未自动重试");
    }
    const full = JSON.stringify(value, null, 2);
    if (target) await writeNew(target, full, signal);
    return { ...(target ? { file: target } : {}), result: full.length <= 24000 ? value : full.slice(0, 24000),
        ...(full.length > 24000 ? { truncated: true, notice: target ? "完整 JSON 已保存至 file" : "展示已截断；可提供 output_file 保存完整 JSON" } : {}) };
}
