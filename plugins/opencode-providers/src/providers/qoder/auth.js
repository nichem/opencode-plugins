import { getMachineId } from "./cosy.js";
import { QODER_EXCHANGE_URL, QODER_USERINFO_URL, USER_AGENT } from "./constants.js";
// Internal credential channel; JSON plugin/provider settings cannot supply it.
export const CONNECTION_PAT = Symbol("Qoder connection PAT");
export const PAT_REFRESH_PREFIX = "pat";
const credentialsCache = new Map();
const pendingCredentials = new Map();
const AUTH_TIMEOUT_MS = 15000;
export function encodePatRefresh(pat, jobRefreshToken, userID, machineID) {
    return [PAT_REFRESH_PREFIX, pat, jobRefreshToken, userID, machineID].join("|");
}
export function decodePatRefresh(refresh) {
    const parts = refresh.split("|");
    return {
        pat: parts[1] || "",
        jobRefreshToken: parts[2] || "",
        userID: parts[3] || "",
        machineID: parts[4] || "",
    };
}
function parseExpiresAt(expiresAt, expiresIn) {
    if (expiresAt) {
        const parsed = Date.parse(expiresAt);
        if (!Number.isNaN(parsed))
            return parsed;
        const numeric = Number.parseInt(expiresAt, 10);
        if (Number.isFinite(numeric) && numeric > 0)
            return numeric;
    }
    if (expiresIn && expiresIn > 0) {
        // PAT exchange returns milliseconds; browser device flow returns seconds.
        return Date.now() + (expiresIn > 7 * 24 * 60 * 60 ? expiresIn : expiresIn * 1000);
    }
    return Date.now() + 24 * 60 * 60 * 1000;
}
async function fetchUserInfo(jobToken, signal) {
    try {
        const res = await fetch(QODER_USERINFO_URL, {
            signal,
            headers: {
                Authorization: `Bearer ${jobToken}`,
                Accept: "application/json",
                "User-Agent": USER_AGENT,
                "Cosy-Version": "1.0.1",
                "Cosy-ClientType": "5",
            },
        });
        if (!res.ok)
            return { userID: "", email: "", name: "" };
        const info = (await res.json());
        return {
            userID: info.id || "",
            email: info.email || "",
            name: info.name || info.username || "",
        };
    }
    catch (error) {
        if (signal.aborted)
            throw signal.reason;
        return { userID: "", email: "", name: "" };
    }
}
export async function credentialsFromPat(pat, signal) {
    signal?.throwIfAborted();
    const cached = credentialsCache.get(pat);
    if (cached?.expires > Date.now())
        return cached;
    credentialsCache.delete(pat);
    let entry = pendingCredentials.get(pat);
    if (!entry) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("Qoder authentication timed out", "TimeoutError")), AUTH_TIMEOUT_MS);
        entry = { controller, waiters: 0, promise: undefined };
        const signal = controller.signal;
        const pending = (async () => {
            const res = await fetch(QODER_EXCHANGE_URL, {
                signal,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "User-Agent": USER_AGENT,
                    "Cosy-Version": "1.0.1",
                    "Cosy-ClientType": "5",
                    "Cosy-MachineId": getMachineId(),
                },
                body: JSON.stringify({ personal_token: pat }),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                throw new Error(`Qoder PAT exchange failed: ${res.status} ${res.statusText}. ${text.slice(0, 200)}`);
            }
            const data = (await res.json());
            if (!data.token)
                throw new Error("Qoder PAT exchange returned no job token");
            const profile = await fetchUserInfo(data.token, signal);
            signal.throwIfAborted();
            const machineID = getMachineId();
            return {
                refresh: encodePatRefresh(pat, data.refresh_token || "", profile.userID, machineID),
                access: data.token,
                expires: parseExpiresAt(data.expires_at, data.expires_in) - 5 * 60 * 1000,
                userID: profile.userID || "qoder-user",
                email: profile.email || "user@qoder.com",
                name: profile.name || "Qoder User",
                machineID,
            };
        })();
        entry.promise = pending.then((resolved) => {
            if (!signal.aborted)
                credentialsCache.set(pat, resolved);
            return resolved;
        }).finally(() => {
            clearTimeout(timer);
            if (pendingCredentials.get(pat) === entry)
                pendingCredentials.delete(pat);
        });
        pendingCredentials.set(pat, entry);
    }
    entry.waiters++;
    let abort;
    try {
        if (!signal)
            return await entry.promise;
        return await Promise.race([
            entry.promise,
            new Promise((_, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
            }),
        ]);
    } finally {
        if (abort) signal.removeEventListener("abort", abort);
        entry.waiters--;
        if (entry.waiters === 0 && pendingCredentials.get(pat) === entry) {
            pendingCredentials.delete(pat);
            entry.controller.abort(signal?.reason);
        }
    }
}
export async function resolveQoderCredentials(options = {}, signal) {
    const token = (options[CONNECTION_PAT] ?? "").trim();
    if (!token) {
        throw new Error("Qoder PAT not set. Use /connect to select Qoder CN and enter a pt-... PAT.");
    }
    if (!token.startsWith("pt-") || token.length <= 3) {
        throw new Error("Qoder CN only supports Personal Access Tokens starting with pt-. Direct access tokens and browser OAuth login are not supported.");
    }
    return credentialsFromPat(token, signal);
}
