import { setTimeout as delay } from "node:timers/promises";
import * as upstream from "./upstream.js";

export const API_BASE = "https://api2.cursor.sh";
const METHOD = "browser";
const missing = () => new Error("Cursor: 请通过 /connect → Cursor 登录或输入 API Key。");

// Bounded polling; no auth.json, token file, config key or environment fallback.
export async function pollLogin(uuid, verifier, signal, send = fetch, sleep = delay) {
    let failures = 0;
    for (;;) {
        signal.throwIfAborted();
        await sleep(1000, undefined, { signal });
        let response;
        try {
            response = await send(`${API_BASE}/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: "error",
            });
            if (response.status === 404) { failures = 0; continue; }
            if (response.ok) {
                const body = await response.json();
                if (typeof body.accessToken === "string" && body.accessToken && typeof body.refreshToken === "string" && body.refreshToken)
                    return { type: "oauth", methodID: METHOD, access: body.accessToken, refresh: body.refreshToken,
                        expires: upstream.decodeJwtExpiryMs(body.accessToken) ?? Date.now() };
            }
        } catch { signal.throwIfAborted(); }
        if (++failures >= 3) throw new Error("Cursor: 浏览器登录未完成，请重新连接。");
    }
}

export function connectionAuth(ctx, protocol = upstream) {
    const controllers = new Set();
    async function read() {
        const connection = await ctx.integration.connection.active("cursor");
        if (connection?.type !== "credential") throw missing();
        const credential = await ctx.integration.connection.resolve(connection);
        if (credential?.type === "key" && credential.key?.trim()) return { connection, credential };
        if (credential?.type === "oauth" && credential.access) return { connection, credential };
        throw missing();
    }
    async function token(saved, request = {}) {
        const credential = saved.credential;
        if (credential.type === "key") {
            const key = credential.key.trim();
            return protocol.isExchangeableApiKey(key)
                ? (await protocol.resolveApiKeyToken(key, { baseUrl: API_BASE, force: request.forceRefresh === true })).accessToken : key;
        }
        return (await protocol.renewSessionIfDue({ accessToken: credential.access, refreshToken: credential.refresh || credential.access },
            { baseUrl: API_BASE, force: request.forceRefresh === true })).accessToken;
    }
    async function refresh(credential) {
        const result = await protocol.renewSessionIfDue({ accessToken: credential.access, refreshToken: credential.refresh || credential.access }, { baseUrl: API_BASE });
        return { ...credential, methodID: METHOD,
            access: result.accessToken, refresh: result.renewed ? result.accessToken : credential.refresh,
            expires: result.retryAt ?? protocol.decodeJwtExpiryMs(result.accessToken) ?? Date.now() };
    }
    async function register() {
        await ctx.integration.transform(editor => {
            editor.update("cursor", item => { item.name = "Cursor"; });
            editor.method.update({ integrationID: "cursor", method: { type: "key", label: "Cursor API Key" } });
            editor.method.update({ integrationID: "cursor", method: { id: METHOD, type: "oauth", label: "Cursor 浏览器登录" }, refresh,
                authorize: async () => {
                    const { uuid, verifier } = protocol.generatePkceParams();
                    const challenge = await protocol.generatePkceChallenge(verifier);
                    const controller = new AbortController();
                    controllers.add(controller);
                    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
                    const callback = pollLogin(uuid, verifier, signal).finally(() => controllers.delete(controller));
                    // Host may dismiss the form before awaiting the callback.
                    void callback.catch(() => {});
                    return { url: protocol.buildLoginUrl(challenge, uuid, "https://cursor.com"), mode: "auto", callback,
                        expiresAt: Date.now() + 180000, instructions: "在浏览器中登录 Cursor，然后返回 OpenCode。" };
                } });
        });
    }
    return { read, token, refresh, register, dispose() { for (const controller of controllers) controller.abort(); controllers.clear(); } };
}
