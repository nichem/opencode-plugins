import { Plugin, Provider, Model } from "@opencode/plugin"
import { Schema } from "effect"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

let calls = 0
export function createMock() {
  return { languageModel: () => ({
    specificationVersion: "v3", provider: "delete-test", modelId: "test", supportedUrls: {},
    async doStream() {
      calls++
      if (calls > 4) throw new Error("Unexpected smoke model loop")
      const tool = calls === 1
      const parts = [{ type: "stream-start", warnings: [] }]
      if (tool) parts.push({ type: "tool-call", toolCallId: "write", toolName: "smoke_write", input: "{}" })
      else parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: `Final reply ${calls}` }, { type: "text-end", id: "t" })
      parts.push({ type: "finish", finishReason: { unified: tool ? "tool-calls" : "stop", raw: tool ? "tool_calls" : "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } })
      return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } }) }
    },
  }) }
}

export default Plugin.define({ id: "delete-test-provider", async setup(ctx) {
  const providerID = Provider.ID.make("delete-test")
  await ctx.provider.transform(editor => editor.add({
    info: { ...Provider.Info.empty(providerID), name: "Delete test (offline)", activation: "enabled", package: `aisdk:${import.meta.url}` },
    models: [Model.Info.default(providerID, Model.ID.make("test"))],
  }))
  await ctx.tool.transform(editor => editor.add({ name: "smoke_write", description: "Write an isolated smoke fixture",
    input: Schema.Struct({}), options: { codemode: false },
    execute: async () => { await writeFile(join(ctx.location.directory, "fixture.txt"), "changed by tool\n"); return { content: "written" } },
  }))
} })
