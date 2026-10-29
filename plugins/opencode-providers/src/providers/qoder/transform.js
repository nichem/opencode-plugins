function dataContentToUrl(part) {
    if (part.data instanceof URL)
        return part.data.toString();
    if (typeof part.data === "string") {
        if (/^(https?:|data:)/i.test(part.data))
            return part.data;
        return `data:${part.mediaType};base64,${part.data}`;
    }
    return `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`;
}
function stringifyToolResultOutput(output) {
    switch (output.type) {
        case "text":
        case "error-text":
            return output.value;
        case "json":
        case "error-json":
            return JSON.stringify(output.value);
        case "execution-denied":
            return output.reason ? `Execution denied: ${output.reason}` : "Execution denied";
        case "content":
            return output.value
                .map((part) => {
                if (part.type === "text")
                    return part.text;
                if (part.type === "file-url")
                    return part.url;
                if (part.type === "file-id")
                    return typeof part.fileId === "string" ? part.fileId : JSON.stringify(part.fileId);
                if (part.type === "image-url")
                    return part.url;
                if (part.type === "image-file-id")
                    return typeof part.fileId === "string" ? part.fileId : JSON.stringify(part.fileId);
                return "mediaType" in part ? `[${part.mediaType}]` : `[${part.type}]`;
            })
                .join("\n");
    }
}
function textFromContent(content) {
    if (!content)
        return "";
    if (typeof content === "string")
        return content;
    return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
function transformUserMessage(message) {
    const parts = [];
    let hasFile = false;
    for (const part of message.content) {
        if (part.type === "text") {
            parts.push({ type: "text", text: part.text });
            continue;
        }
        if (part.type === "file" && part.mediaType.startsWith("image/")) {
            hasFile = true;
            parts.push({ type: "image_url", image_url: { url: dataContentToUrl(part) } });
        }
    }
    return {
        role: "user",
        content: hasFile ? parts : parts.map((part) => (part.type === "text" ? part.text : "")).join(""),
    };
}
function transformAssistantMessage(message) {
    let content = "";
    const toolCalls = [];
    for (const part of message.content) {
        if (part.type === "text")
            content += part.text;
        if (part.type === "reasoning")
            content += `<thinking>${part.text}</thinking>\n\n`;
        if (part.type === "tool-call") {
            toolCalls.push({
                id: part.toolCallId,
                type: "function",
                function: {
                    name: part.toolName,
                    arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input),
                },
            });
        }
    }
    const result = { role: "assistant", content: content || null };
    if (toolCalls.length > 0)
        result.tool_calls = toolCalls;
    return result;
}
function transformToolMessage(message) {
    return message.content.flatMap((part) => {
        if (part.type !== "tool-result")
            return [];
        return [
            {
                role: "tool",
                tool_call_id: part.toolCallId,
                content: stringifyToolResultOutput(part.output),
            },
        ];
    });
}
function normalizeToolExchanges(messages) {
    const normalized = [];
    let pendingToolCallIDs = [];
    let fallbackID = 0;
    for (const message of messages) {
        if (message.role === "assistant") {
            pendingToolCallIDs = [];
            if (!message.tool_calls?.length) {
                normalized.push(message);
                continue;
            }
            const toolCalls = message.tool_calls.map((toolCall) => {
                const id = toolCall.id?.trim() || `call_qoder_${fallbackID++}`;
                pendingToolCallIDs.push(id);
                return id === toolCall.id ? toolCall : { ...toolCall, id };
            });
            normalized.push({ ...message, tool_calls: toolCalls });
            continue;
        }
        if (message.role === "tool") {
            const id = message.tool_call_id?.trim();
            const matchIndex = id ? pendingToolCallIDs.indexOf(id) : pendingToolCallIDs.length > 0 ? 0 : -1;
            if (matchIndex === -1)
                continue;
            const [matchedID] = pendingToolCallIDs.splice(matchIndex, 1);
            normalized.push(matchedID === message.tool_call_id ? message : { ...message, tool_call_id: matchedID });
            continue;
        }
        pendingToolCallIDs = [];
        normalized.push(message);
    }
    return normalized;
}
export function transformPrompt(prompt) {
    const system = [];
    const messages = [];
    for (const message of prompt) {
        if (message.role === "system") {
            system.push(message.content);
            continue;
        }
        if (message.role === "user") {
            messages.push(transformUserMessage(message));
            continue;
        }
        if (message.role === "assistant") {
            messages.push(transformAssistantMessage(message));
            continue;
        }
        if (message.role === "tool")
            messages.push(...transformToolMessage(message));
    }
    const normalizedMessages = normalizeToolExchanges(messages);
    let lastUserText = "";
    for (let i = normalizedMessages.length - 1; i >= 0; i--) {
        if (normalizedMessages[i].role !== "user")
            continue;
        lastUserText = textFromContent(normalizedMessages[i].content);
        break;
    }
    return { system: system.join("\n\n"), messages: normalizedMessages, lastUserText };
}
export function transformTools(tools) {
    if (!tools?.length)
        return { tools: [], ignoredTools: 0 };
    const result = [];
    let ignoredTools = 0;
    for (const tool of tools) {
        if (tool.type !== "function") {
            ignoredTools++;
            continue;
        }
        const functionTool = tool;
        result.push({
            type: "function",
            function: {
                name: functionTool.name,
                description: functionTool.description,
                parameters: functionTool.inputSchema,
            },
        });
    }
    return { tools: result, ignoredTools };
}
