/** @param {number} milliseconds */
export function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`;
}

/**
 * Read the current thought alone, or its trailing group of adjacent thoughts.
 * Never count tool execution, answer streaming, idle time or an earlier turn.
 * @param {import('@opencode/client').SessionMessageInfo[]} messages
 * @param {'idle' | 'running'} status
 * @param {number} now
 * @param {'group' | 'part'} scope
 * @returns {number | undefined}
 */
export function liveDuration(messages, status, now, scope = "group") {
    if (status !== "running") return;
    const index = messages.findLastIndex(message => message.type === "assistant");
    const current = messages[index];
    if (current?.type !== "assistant" || current.time.completed !== undefined || current.error || current.retry) return;
    const last = current.content.findLast(part => part.type === "tool" || part.text.replace("[REDACTED]", "").trim());
    if (last?.type !== "reasoning" || last.time?.completed !== undefined) return;
    if (scope === "part") {
        const start = last.time?.created ?? current.time.created;
        return Number.isFinite(start) && Number.isFinite(now) ? Math.max(0, now - start) : undefined;
    }

    let duration = 0;
    for (let i = index; i >= 0; i--) {
        const message = messages[i];
        // The native timeline omits synthetic messages without a description;
        // those invisible context updates do not end the displayed group.
        if (message.type === "synthetic" && !message.description?.trim()) continue;
        if (message.type !== "assistant") break;
        // A terminal assistant footer separates groups in the host transcript.
        if (i !== index && (message.error || message.retry || (message.finish && !["tool-calls", "unknown"].includes(message.finish)))) break;
        for (let j = message.content.length - 1; j >= 0; j--) {
            const part = message.content[j];
            if (part.type !== "tool" && !part.text.replace("[REDACTED]", "").trim()) continue;
            if (part.type !== "reasoning") return duration;
            const start = part.time?.created ?? message.time.created;
            const end = part.time?.completed ?? message.time.completed ?? now;
            if (!Number.isFinite(start) || !Number.isFinite(end)) return;
            duration += Math.max(0, end - start);
        }
    }
    return duration;
}
