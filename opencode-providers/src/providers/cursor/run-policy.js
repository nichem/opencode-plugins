// Shared by the shipped protocol's ordinary, display and interaction tool paths.
export class CursorToolPolicyError extends Error {}
export function resolveToolPolicy(tools, choice, isCompaction = false) {
    const type = choice?.type ?? "auto";
    if (!["auto", "none", "required", "tool"].includes(type))
        throw new Error("Cursor: unsupported toolChoice");
    const names = new Set(tools.map(tool => tool.name).filter(Boolean));
    if (type === "tool" && !names.has(choice.toolName))
        throw new Error("Cursor: toolChoice names an unavailable tool");
    if (type === "required" && names.size === 0)
        throw new Error("Cursor: toolChoice required needs at least one tool");
    const allowTools = !isCompaction && type !== "none" && names.size > 0;
    return {
        allowTools,
        permittedToolNames: !allowTools ? new Set() : type === "tool" ? new Set([choice.toolName]) : names,
        requireTool: allowTools && (type === "required" || type === "tool"),
    };
}

export const canUseTool = (session, name) => session.allowTools === true && session.permittedToolNames?.has(name) === true;

export function assertToolEmission(session, part) {
    if (part.type === "tool-call" && !canUseTool(session, part.toolName))
        throw new CursorToolPolicyError(`Cursor: tool '${part.toolName}' is not permitted for this call`);
}

export function assertToolFinish(session, emittedTools) {
    if (session.requireTool && emittedTools === 0)
        throw new CursorToolPolicyError("Cursor: toolChoice requires a tool call, but the model finished without one");
}

// Stop waiting without cancelling shared authentication/cache work used by other calls.
// Resource acquisitions that finish after cancellation must dispose their result.
export function waitForAbort(signal, start, disposeLate) {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            callback(value);
        };
        const onAbort = () => finish(reject, signal.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        Promise.resolve().then(() => {
            signal?.throwIfAborted();
            return start();
        }).then(value => {
            if (settled) { disposeLate?.(value); return; }
            finish(resolve, value);
        }, error => finish(reject, error));
    });
}

// Own each new Run until the per-call lifetime takes over, including retry Runs.
export async function prepareRun(signal, manager, setup) {
    let stream, session, transferred = false;
    const destroy = target => { try { target?.destroy(); } catch {} };
    const close = () => {
        if (session) {
            if (!session.closed) manager.close(session, signal?.aborted ? "local-cancel" : "initial-write-failed", signal?.reason);
        } else destroy(stream);
    };
    const check = () => signal?.throwIfAborted();
    signal?.addEventListener("abort", close, { once: true });
    try {
        check();
        const result = await waitForAbort(signal, () => setup({
            check,
            wait: start => waitForAbort(signal, start),
            async open(start) {
                stream = await waitForAbort(signal, start, destroy);
                if (signal?.aborted) { destroy(stream); check(); }
                return stream;
            },
            bind(next) { session = next; if (signal?.aborted) { close(); check(); } },
        }));
        check();
        transferred = true;
        return result;
    } finally {
        signal?.removeEventListener("abort", close);
        if (!transferred) close();
    }
}

// A lifetime belongs to one doStream call, not to its reusable Cursor connection.
// Once tool-calls is emitted, late aborts/cancels belong to the completed call.
export function createCallLifetime(inputSignal, manager) {
    const controller = new AbortController();
    let session, released = false;
    const close = target => {
        if (target && !target.closed) manager.close(target, "local-cancel", controller.signal.reason);
    };
    const cancel = reason => {
        if (released) return;
        controller.abort(reason instanceof Error ? reason : new DOMException("Cursor request cancelled", "AbortError"));
        close(session);
        release();
    };
    const onAbort = () => cancel(inputSignal.reason);
    function release() {
        released = true;
        inputSignal?.removeEventListener("abort", onAbort);
    }
    inputSignal?.addEventListener("abort", onAbort, { once: true });
    if (inputSignal?.aborted) onAbort();
    return {
        signal: controller.signal,
        bind(next) {
            if (controller.signal.aborted) { close(next); controller.signal.throwIfAborted(); }
            if (!released) session = next;
        },
        observe(sink) {
            return {
                enqueue(part) {
                    if (part.type === "finish") release();
                    sink.enqueue(part);
                },
                error(error) { sink.error(error); },
            };
        },
        cancel, release,
    };
}
