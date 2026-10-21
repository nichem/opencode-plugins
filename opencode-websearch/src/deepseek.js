import { HttpClientError, StatusCodeError } from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export const DSS_ID = "dss";
export const DSS_NAME = "DSS";
export const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
export const DSS_QUERY_ERROR = "DSS 搜索词必须为 1～128 个 Unicode 字符，请缩短搜索词后重试";

export class SearchError extends Error {
    constructor(message, status) {
        super(message);
        this.name = "SearchError";
        if (status !== undefined) this.status = status;
    }
}

export class QueryValidationError extends SearchError {
    constructor() {
        super(DSS_QUERY_ERROR);
        this.name = "DSSQueryValidationError";
        this.code = "DSS_QUERY_INVALID";
    }
}

export function validateQuery(query) {
    if (!query.trim() || [...query].length > 128) throw new QueryValidationError();
}

// OpenCode wraps provider failures in WebSearch.Request and then Tool.Error.
// Recognize only our local validation marker; never forward upstream messages.
export function isQueryValidationFailure(error) {
    const request = error?._tag === "Tool.Error" ? error.error : error;
    const cause = request?.cause;
    return request?._tag === "WebSearch.Request" && request.providerID === DSS_ID
        && cause?.name === "DSSQueryValidationError" && cause.code === "DSS_QUERY_INVALID" && cause.message === DSS_QUERY_ERROR;
}

// OpenCode's native random strategy recognizes Effect HTTP errors. Preserve only
// the status and retry hint, without retaining the key, response body or cookies.
export function rateLimitError(response) {
    const request = HttpClientRequest.post(SEARCH_URL);
    const retryAfter = response.headers.get("retry-after");
    const sanitized = new Response(null, { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} });
    const error = new HttpClientError({ reason: new StatusCodeError({
        request, response: HttpClientResponse.fromWeb(request, sanitized), description: "DSS 搜索被限流，请稍后重试",
    }) });
    error.status = 429;
    return error;
}

export async function dssCredential(integration) {
    const connection = await integration.connection.active(DSS_ID);
    if (connection?.type !== "credential") return;
    const value = await integration.connection.resolve(connection);
    if (value?.type === "key" && value.key.trim()) return value.key;
}

export function parseResults(value) {
    if (!value || !Array.isArray(value.results)) throw new SearchError("DSS 返回了无效的搜索结果");
    return value.results.map(item => {
        if (!item || typeof item.url !== "string" || !/^https?:\/\//i.test(item.url))
            throw new SearchError("DSS 返回了无效的搜索链接");
        const content = [item.summary, item.snippet, item.content].find(text => typeof text === "string" && text.trim());
        const published = typeof item.date === "string" ? Date.parse(item.date) : NaN;
        return {
            url: item.url,
            ...(typeof item.title === "string" ? { title: item.title } : {}),
            ...(content ? { content } : {}),
            time: Number.isFinite(published) ? { published } : {},
        };
    });
}

export async function searchDeepSeek(query, key, requestSignal, transport = globalThis.fetch) {
    validateQuery(query);
    const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(20000)]);
    signal.throwIfAborted();
    let response;
    try {
        response = await transport(SEARCH_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ query, count: 10, need_content: false }),
            signal, redirect: "error",
        });
    } catch (error) {
        if (requestSignal.aborted) throw error;
        throw new SearchError(signal.aborted ? "DSS 搜索超时" : "DSS 搜索网络异常");
    }
    if (!response.ok) {
        if (response.status === 429) throw rateLimitError(response);
        const message = response.status === 401 ? "DSS 凭据无效，请通过 /connect 检查 DSS 连接"
            : response.status === 402 ? "DeepSeek 余额不足"
            : `DSS 搜索失败（HTTP ${response.status}）`;
        // Do not expose upstream error bodies: they can contain connection secrets.
        throw new SearchError(message, response.status);
    }
    let value;
    try { value = await response.json(); } catch (error) {
        if (requestSignal.aborted) throw error;
        throw new SearchError(signal.aborted ? "DSS 搜索超时" : "DSS 返回了无效的 JSON");
    }
    signal.throwIfAborted();
    return parseResults(value);
}
