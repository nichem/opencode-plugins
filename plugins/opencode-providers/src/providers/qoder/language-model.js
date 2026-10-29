import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveQoderCredentials } from "./auth.js";
import { buildAuthHeaders } from "./cosy.js";
import { getModelDefinition, QODER_CHAT_URL, USER_AGENT } from "./constants.js";
import { qoderEncodeBody } from "./encoding.js";
import { transformPrompt, transformTools } from "./transform.js";
const THINKING_TAG_VARIANTS = [
    { open: "<thinking>", close: "</thinking>" },
    { open: "<think>", close: "</think>" },
    { open: "<reasoning>", close: "</reasoning>" },
    { open: "<thought>", close: "</thought>" },
];
function stableHash(prefix, ...inputs) {
    const hash = crypto.createHash("sha256");
    hash.update(prefix);
    for (const input of inputs) {
        hash.update("\0");
        hash.update(input);
    }
    return hash.digest("hex").slice(0, 16);
}
function stableChatRecordID(model, messages, tools, maxTokens) {
    const hash = crypto.createHash("sha256");
    hash.update("qoder-record");
    hash.update("\0");
    hash.update(model);
    for (const message of messages) {
        hash.update("\0");
        hash.update(message.role);
        if (message.content)
            hash.update(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
        if (message.tool_calls)
            hash.update(JSON.stringify(message.tool_calls));
    }
    if (tools.length) {
        hash.update("\0");
        hash.update(JSON.stringify(tools));
    }
    hash.update("\0");
    hash.update(`mt=${maxTokens}`);
    return hash.digest("hex").slice(0, 16);
}
function mapFinishReason(raw, hasToolCalls) {
    if (hasToolCalls || raw === "tool_calls" || raw === "function_call")
        return { unified: "tool-calls", raw };
    if (raw === "length")
        return { unified: "length", raw };
    if (raw === "content_filter")
        return { unified: "content-filter", raw };
    if (!raw || raw === "stop")
        return { unified: "stop", raw };
    return { unified: "other", raw };
}
function usageFromQoder(raw) {
    const promptTokens = raw?.prompt_tokens;
    const cachedTokens = raw?.prompt_tokens_details?.cached_tokens;
    return {
        inputTokens: {
            total: promptTokens,
            noCache: promptTokens !== undefined && cachedTokens !== undefined ? promptTokens - cachedTokens : undefined,
            cacheRead: cachedTokens,
            cacheWrite: undefined,
        },
        outputTokens: {
            total: raw?.completion_tokens,
            text: undefined,
            reasoning: raw?.completion_tokens_details?.reasoning_tokens,
        },
        raw: raw,
    };
}
function isParsableJson(input) {
    try {
        JSON.parse(input);
        return true;
    }
    catch {
        return false;
    }
}
function getTrailingPossibleTagPrefixLength(text, tag) {
    const maxPrefixLength = Math.min(text.length, tag.length - 1);
    for (let len = maxPrefixLength; len > 0; len--) {
        if (text.endsWith(tag.slice(0, len)))
            return len;
    }
    return 0;
}
function getMaxTrailingPossibleTagPrefixLength(text, tags) {
    let maxLength = 0;
    for (const tag of tags)
        maxLength = Math.max(maxLength, getTrailingPossibleTagPrefixLength(text, tag));
    return maxLength;
}
class StreamEmitter {
    controller;
    textID;
    reasoningID;
    textIndex = 0;
    constructor(controller) {
        this.controller = controller;
    }
    text(delta) {
        if (!delta)
            return;
        this.endReasoning();
        if (!this.textID) {
            this.textID = `txt-${this.textIndex++}`;
            this.controller.enqueue({ type: "text-start", id: this.textID });
        }
        this.controller.enqueue({ type: "text-delta", id: this.textID, delta });
    }
    endText() {
        if (!this.textID)
            return;
        this.controller.enqueue({ type: "text-end", id: this.textID });
        this.textID = undefined;
    }
    reasoning(delta) {
        if (!delta)
            return;
        if (!this.reasoningID) {
            this.endText();
            this.reasoningID = "reasoning-0";
            this.controller.enqueue({ type: "reasoning-start", id: this.reasoningID });
        }
        this.controller.enqueue({ type: "reasoning-delta", id: this.reasoningID, delta });
    }
    endReasoning() {
        if (!this.reasoningID)
            return;
        this.controller.enqueue({ type: "reasoning-end", id: this.reasoningID });
        this.reasoningID = undefined;
    }
    closeOpenBlocks() {
        this.endReasoning();
        this.endText();
    }
}
class ThinkingTagParser {
    emitter;
    textBuffer = "";
    inThinking = false;
    thinkingExtracted = false;
    activeEndTag = THINKING_TAG_VARIANTS[0].close;
    constructor(emitter) {
        this.emitter = emitter;
    }
    process(chunk) {
        this.textBuffer += chunk;
        while (this.textBuffer.length > 0) {
            const prevLength = this.textBuffer.length;
            if (!this.inThinking && !this.thinkingExtracted) {
                this.processBeforeThinking();
                if (this.textBuffer.length === 0)
                    break;
            }
            if (this.inThinking) {
                this.processInsideThinking();
                if (this.textBuffer.length === 0)
                    break;
            }
            if (this.thinkingExtracted) {
                this.emitter.text(this.textBuffer);
                this.textBuffer = "";
                break;
            }
            if (this.textBuffer.length >= prevLength)
                break;
        }
    }
    finalize() {
        if (!this.textBuffer)
            return;
        if (this.inThinking) {
            this.emitter.reasoning(this.textBuffer);
            this.emitter.endReasoning();
        }
        else {
            this.emitter.text(this.textBuffer);
        }
        this.textBuffer = "";
    }
    processBeforeThinking() {
        let bestPos = -1;
        let bestVariant;
        for (const variant of THINKING_TAG_VARIANTS) {
            const pos = this.textBuffer.indexOf(variant.open);
            if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
                bestPos = pos;
                bestVariant = variant;
            }
        }
        if (bestPos !== -1 && bestVariant) {
            if (bestPos > 0)
                this.emitter.text(this.textBuffer.slice(0, bestPos));
            this.textBuffer = this.textBuffer.slice(bestPos + bestVariant.open.length);
            this.activeEndTag = bestVariant.close;
            this.inThinking = true;
            return;
        }
        const trailingPrefixLength = getMaxTrailingPossibleTagPrefixLength(this.textBuffer, THINKING_TAG_VARIANTS.map((variant) => variant.open));
        const safeLen = this.textBuffer.length - trailingPrefixLength;
        if (safeLen > 0) {
            this.emitter.text(this.textBuffer.slice(0, safeLen));
            this.textBuffer = this.textBuffer.slice(safeLen);
        }
    }
    processInsideThinking() {
        const endPos = this.textBuffer.indexOf(this.activeEndTag);
        if (endPos !== -1) {
            if (endPos > 0)
                this.emitter.reasoning(this.textBuffer.slice(0, endPos));
            this.emitter.endReasoning();
            this.textBuffer = this.textBuffer.slice(endPos + this.activeEndTag.length);
            this.inThinking = false;
            this.thinkingExtracted = true;
            if (this.textBuffer.startsWith("\n\n"))
                this.textBuffer = this.textBuffer.slice(2);
            return;
        }
        const trailingPrefixLength = getTrailingPossibleTagPrefixLength(this.textBuffer, this.activeEndTag);
        const safeLen = this.textBuffer.length - trailingPrefixLength;
        if (safeLen > 0) {
            this.emitter.reasoning(this.textBuffer.slice(0, safeLen));
            this.textBuffer = this.textBuffer.slice(safeLen);
        }
    }
}
function effortFromBudget(tokens) {
    if (typeof tokens !== "number" || !Number.isFinite(tokens))
        return undefined;
    if (tokens <= 0)
        return "none";
    if (tokens <= 1024)
        return "low";
    if (tokens <= 8192)
        return "medium";
    if (tokens <= 24576)
        return "high";
    return "max";
}
function effortFromSource(source) {
    if (!source || typeof source !== "object")
        return undefined;
    const direct = source.reasoningEffort ?? source.reasoning_effort ?? source.effort;
    if (typeof direct === "string" && direct.length > 0 && direct !== "default")
        return direct;
    const thinking = source.thinking;
    if (thinking && typeof thinking === "object") {
        const nested = thinking.effort ?? thinking.level;
        if (typeof nested === "string" && nested.length > 0)
            return nested;
    }
    return effortFromBudget(source.thinkingBudget ?? source.thinking_budget ?? source.reasoningBudget ?? source.reasoning_budget);
}
function resolveReasoningEffort(requestOptions, providerOptions) {
    const requestProviderOptions = requestOptions?.providerOptions;
    if (!requestProviderOptions || typeof requestProviderOptions !== "object")
        return effortFromSource(providerOptions);
    const preferred = effortFromSource(requestProviderOptions.qoder);
    if (preferred)
        return preferred;
    for (const value of Object.values(requestProviderOptions)) {
        const found = effortFromSource(value);
        if (found)
            return found;
    }
    return effortFromSource(providerOptions);
}
function buildRequestBody(modelID, options, userID, providerOptions) {
    const model = providerOptions?.modelDefinition ?? getModelDefinition(modelID);
    const transformed = transformPrompt(options.prompt);
    let { tools, ignoredTools } = transformTools(options.tools);
    let toolChoice;
    switch (options.toolChoice?.type) {
        case undefined:
            break;
        case "auto":
            toolChoice = "auto";
            break;
        case "none":
            tools = [];
            toolChoice = "none";
            break;
        case "required":
            if (!tools.length)
                throw new Error("Qoder toolChoice required needs at least one function tool");
            toolChoice = "required";
            break;
        case "tool":
            tools = tools.filter(tool => tool.function.name === options.toolChoice.toolName);
            if (!tools.length)
                throw new Error("Qoder toolChoice names an unavailable function tool");
            toolChoice = { type: "function", function: { name: options.toolChoice.toolName } };
            break;
        default:
            throw new Error("Unsupported Qoder toolChoice");
    }
    const warnings = [];
    if (ignoredTools > 0)
        warnings.push({ type: "unsupported", feature: "provider-defined tools" });
    if (options.stopSequences?.length)
        warnings.push({ type: "unsupported", feature: "stop sequences" });
    if (options.responseFormat?.type === "json")
        warnings.push({ type: "unsupported", feature: "JSON response format" });
    let maxTokens = model.maxTokens;
    if (options.maxOutputTokens && options.maxOutputTokens < maxTokens)
        maxTokens = options.maxOutputTokens;
    const recordID = stableChatRecordID(modelID, transformed.messages, tools, maxTokens);
    const sessionID = stableHash("qoder-session", userID, modelID);
    const parameters = { max_tokens: maxTokens };
    if (typeof options.temperature === "number")
        parameters.temperature = options.temperature;
    if (typeof options.topP === "number")
        parameters.top_p = options.topP;
    const reasoningEffort = resolveReasoningEffort(options, providerOptions);
    if (reasoningEffort) {
        parameters.reasoning_effort = reasoningEffort;
        parameters.enable_thinking = reasoningEffort !== "none";
    }
    return {
        warnings,
        body: {
            request_id: crypto.randomUUID(),
            request_set_id: recordID,
            chat_record_id: recordID,
            session_id: sessionID,
            stream: true,
            chat_task: "FREE_INPUT",
            is_reply: true,
            is_retry: false,
            source: 1,
            version: "3",
            session_type: "qodercli",
            agent_id: "agent_common",
            task_id: "common",
            code_language: "",
            chat_prompt: "",
            image_urls: null,
            aliyun_user_type: "",
            system: "",
            messages: transformed.system ? [{ role: "system", content: transformed.system }, ...transformed.messages] : transformed.messages,
            tools,
            ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
            parameters,
            chat_context: {
                chatPrompt: "",
                imageUrls: null,
                extra: {
                    context: [],
                    modelConfig: {
                        key: modelID,
                        is_reasoning: model.reasoning,
                    },
                    originalContent: transformed.lastUserText,
                },
                features: [],
                text: transformed.lastUserText,
            },
            model_config: {
                key: modelID,
                is_reasoning: model.reasoning,
                max_output_tokens: model.maxTokens,
                source: "system",
            },
            business: {
                product: "cli",
                version: "1.0.0",
                type: "agent",
                stage: "start",
                id: crypto.randomUUID(),
                name: transformed.lastUserText.substring(0, 30),
                begin_at: Date.now(),
            },
        },
    };
}
const SSE_DONE = Symbol("sse-done");
function parseSSELine(line) {
    if (!line.startsWith("data:"))
        return undefined;
    const dataStr = line.substring(5).trim();
    if (dataStr === "[DONE]")
        return SSE_DONE;
    if (!dataStr)
        return undefined;
    const envelope = JSON.parse(dataStr);
    if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
        throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
    }
    if (envelope.body === "[DONE]")
        return SSE_DONE;
    if (!envelope.body)
        return undefined;
    return JSON.parse(envelope.body);
}
export class QoderLanguageModel {
    modelId;
    providerOptions;
    specificationVersion = "v3";
    provider = "qoder";
    supportedUrls = { "image/*": [/^data:/, /^https?:/] };
    constructor(modelId, providerOptions = {}) {
        this.modelId = modelId;
        this.providerOptions = providerOptions;
    }
    async doGenerate(options) {
        const result = await this.doStream(options);
        const content = [];
        const textByID = new Map();
        const reasoningByID = new Map();
        let finishReason = { unified: "stop", raw: undefined };
        let usage = usageFromQoder();
        const warnings = [];
        for await (const part of result.stream) {
            if (part.type === "stream-start")
                warnings.push(...part.warnings);
            if (part.type === "text-start") {
                const block = { type: "text", text: "" };
                textByID.set(part.id, block);
                content.push(block);
            }
            if (part.type === "text-delta")
                textByID.get(part.id).text += part.delta;
            if (part.type === "reasoning-start") {
                const block = { type: "reasoning", text: "" };
                reasoningByID.set(part.id, block);
                content.push(block);
            }
            if (part.type === "reasoning-delta")
                reasoningByID.get(part.id).text += part.delta;
            if (part.type === "tool-call") {
                content.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
            }
            if (part.type === "finish") {
                finishReason = part.finishReason;
                usage = part.usage;
            }
            if (part.type === "error")
                throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
        return { content, finishReason, usage, warnings, request: result.request, response: result.response };
    }
    async doStream(options) {
        const credentials = await resolveQoderCredentials(this.providerOptions, options.abortSignal);
        const { body, warnings } = buildRequestBody(this.modelId, options, credentials.userID, this.providerOptions);
        if (process.env.QODERCN_DEBUG_BODY) {
            try {
                writeFileSync(join(tmpdir(), "opencode-qoder-cn-last-request.json"), JSON.stringify({
                    model: this.modelId,
                    providerOptions: this.providerOptions,
                    requestProviderOptions: options.providerOptions,
                    parameters: body.parameters,
                    systemLength: typeof body.system === "string" ? body.system.length : null,
                    system: body.system,
                    messageCount: Array.isArray(body.messages) ? body.messages.length : null,
                    messages: body.messages,
                    chatContext: body.chat_context,
                }, null, 2));
            }
            catch { }
        }
        const bodyBytes = Buffer.from(JSON.stringify(body));
        const encodedBody = qoderEncodeBody(bodyBytes);
        const encodedBytes = Buffer.from(encodedBody, "utf8");
        const headers = buildAuthHeaders(encodedBytes, QODER_CHAT_URL, {
            userID: credentials.userID,
            authToken: credentials.access,
            name: credentials.name,
            email: credentials.email,
            machineID: credentials.machineID,
        });
        const abortController = new AbortController();
        const abort = () => abortController.abort(options.abortSignal?.reason);
        if (options.abortSignal?.aborted)
            abort();
        else
            options.abortSignal?.addEventListener("abort", abort, { once: true });
        const cleanup = () => options.abortSignal?.removeEventListener("abort", abort);
        try {
            // Use OpenCode's supplied fetch so request hooks and transport timeouts apply.
            const send = this.providerOptions.fetch ?? fetch;
            const response = await send(QODER_CHAT_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Accept-Encoding": "identity",
                    "User-Agent": USER_AGENT,
                    "X-Model-Key": this.modelId,
                    "X-Model-Source": "system",
                    ...this.providerOptions.headers,
                    ...headers,
                },
                body: encodedBytes,
                signal: abortController.signal,
            });
            if (!response.ok) {
                const errText = await response.text().catch(() => "");
                throw new Error(`Qoder API request failed: ${response.status} ${response.statusText}. Response: ${errText}`);
            }
            const stream = this.responseToStream(response, warnings, (reason) => abortController.abort(reason), cleanup, options.toolChoice);
            return { stream, request: { body }, response: { headers: Object.fromEntries(response.headers.entries()) } };
        } catch (error) {
            cleanup();
            abortController.abort(error);
            throw error;
        }
    }
    responseToStream(response, warnings, abortUpstream = () => {}, cleanup = () => {}, toolChoice) {
        const modelID = this.modelId;
        let reader;
        let cancelled = false;
        return new ReadableStream({
            async start(controller) {
                controller.enqueue({ type: "stream-start", warnings });
                reader = response.body?.getReader();
                if (!reader) {
                    cleanup();
                    abortUpstream();
                    throw new Error("Qoder response body is empty");
                }
                const decoder = new TextDecoder();
                const emitter = new StreamEmitter(controller);
                const tagParser = new ThinkingTagParser(emitter);
                const toolCalls = [];
                let buffer = "";
                let rawFinishReason;
                let rawUsage;
                let sawToolCall = false;
                let sawDone = false;
                const finishToolCall = (state) => {
                    if (!state || !state.started || state.finished)
                        return;
                    state.finished = true;
                    controller.enqueue({ type: "tool-input-end", id: state.id });
                    controller.enqueue({ type: "tool-call", toolCallId: state.id, toolName: state.name, input: state.arguments });
                    sawToolCall = true;
                };
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (cancelled)
                            return;
                        buffer += done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true });
                        while (true) {
                            const lineEnd = buffer.indexOf("\n");
                            if (lineEnd === -1)
                                break;
                            const line = buffer.substring(0, lineEnd).trim();
                            buffer = buffer.substring(lineEnd + 1);
                            if (!line)
                                continue;
                            const chunk = parseSSELine(line);
                            if (chunk === SSE_DONE) {
                                sawDone = true;
                                break;
                            }
                            if (!chunk)
                                continue;
                            if (chunk.id || chunk.model || chunk.created) {
                                controller.enqueue({
                                    type: "response-metadata",
                                    id: chunk.id,
                                    modelId: chunk.model || modelID,
                                    timestamp: chunk.created ? new Date(chunk.created * 1000) : undefined,
                                });
                            }
                            if (chunk.usage)
                                rawUsage = chunk.usage;
                            const choice = chunk.choices?.[0];
                            if (!choice)
                                continue;
                            if (choice.finish_reason)
                                rawFinishReason = choice.finish_reason;
                            const delta = choice.delta;
                            if (!delta)
                                continue;
                            if (delta.reasoning_content)
                                emitter.reasoning(delta.reasoning_content);
                            if (delta.content)
                                tagParser.process(delta.content);
                            if (delta.tool_calls) {
                                tagParser.finalize();
                                emitter.endReasoning();
                                for (const toolCallDelta of delta.tool_calls) {
                                    const index = toolCallDelta.index ?? 0;
                                    const state = toolCalls[index] ??
                                        (toolCalls[index] = {
                                            id: toolCallDelta.id || crypto.randomUUID(),
                                            name: toolCallDelta.function?.name || "",
                                            arguments: "",
                                            started: false,
                                            finished: false,
                                        });
                                    if (toolCallDelta.id && !state.started)
                                        state.id = toolCallDelta.id;
                                    if (toolCallDelta.function?.name)
                                        state.name = toolCallDelta.function.name;
                                    if (!state.started && state.name) {
                                        state.started = true;
                                        controller.enqueue({ type: "tool-input-start", id: state.id, toolName: state.name });
                                    }
                                    const argDelta = toolCallDelta.function?.arguments || "";
                                    if (argDelta) {
                                        state.arguments += argDelta;
                                        controller.enqueue({ type: "tool-input-delta", id: state.id, delta: argDelta });
                                    }
                                    // Emit executable tool calls only after successful stream completion.
                                }
                            }
                        }
                        if (done || sawDone)
                            break;
                    }
                    if (!sawDone && !rawFinishReason)
                        throw new Error("Qoder response stream ended before a completion marker");
                    for (const state of toolCalls) {
                        if (state && (!state.started || !isParsableJson(state.arguments)))
                            throw new Error("Qoder response contains an incomplete tool call");
                    }
                    const completedTools = toolCalls.filter(Boolean);
                    if (toolChoice?.type === "none" && completedTools.length)
                        throw new Error("Qoder returned tool calls although toolChoice is none");
                    if ((toolChoice?.type === "required" || toolChoice?.type === "tool") && !completedTools.length)
                        throw new Error("Qoder did not return the required tool call");
                    if (toolChoice?.type === "tool" && completedTools.some(state => state.name !== toolChoice.toolName))
                        throw new Error("Qoder returned a tool other than the requested tool");
                    tagParser.finalize();
                    emitter.closeOpenBlocks();
                    for (const state of toolCalls)
                        finishToolCall(state);
                    controller.enqueue({
                        type: "finish",
                        finishReason: mapFinishReason(rawFinishReason, sawToolCall),
                        usage: usageFromQoder(rawUsage),
                        providerMetadata: { qoder: {} },
                    });
                    controller.close();
                }
                catch (error) {
                    if (cancelled)
                        return;
                    controller.enqueue({ type: "error", error });
                    controller.enqueue({
                        type: "finish",
                        finishReason: { unified: "error", raw: undefined },
                        usage: usageFromQoder(rawUsage),
                        providerMetadata: { qoder: {} },
                    });
                    controller.close();
                }
                finally {
                    cleanup();
                    await reader.cancel().catch(() => { });
                    reader.releaseLock();
                }
            },
            async cancel(reason) {
                cancelled = true;
                abortUpstream(reason);
                cleanup();
                await reader?.cancel(reason).catch(() => { });
            },
        });
    }
}
export function createQoder(options = {}) {
    return {
        languageModel(modelID) {
            return new QoderLanguageModel(modelID, options);
        },
    };
}
