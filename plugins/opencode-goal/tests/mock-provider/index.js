import { Plugin, Provider, Model } from "@opencode/plugin"
import { access, appendFile, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

// Deterministic local model: one unfinished turn, then update_goal, then a final reply.
// No remote API or real credentials are involved.
let calls = 0
let revisionCalls = 0
export function createMock() {
  return { languageModel: (modelID) => ({
    specificationVersion: "v3", provider: "goal-test", modelId: modelID, supportedUrls: {},
    async doStream(options) {
      const slow = modelID === "slow"
      const revision = modelID === "revision"
      if (revision && ++revisionCalls === 1) {
        // Hold the original model request until the smoke test replaces its goal.
        const gate = process.env.GOAL_SMOKE_COMPLETION_GATE
        if (!gate) throw new Error("Missing completion smoke gate")
        await writeFile(`${gate}.started`, "ready")
        let released = false
        for (let i = 0; i < 400; i++) {
          try { await access(gate); released = true; break } catch (error) { if (error.code !== "ENOENT") throw error }
          await delay(25)
        }
        if (!released) throw new Error("Completion smoke gate timed out")
      }
      if (slow) await new Promise(resolve => setTimeout(resolve, 1200))
      calls++
      const prompt = JSON.stringify(options.prompt)
      const goalRevision = [...prompt.matchAll(/<goal_revision>([a-f0-9-]+)<\/goal_revision>/g)].at(-1)?.[1]
      const hasReplacement = prompt.includes("Goal revision replacement fixture")
      // Retry twice with the old context even after OpenCode refreshes tools.
      // Then end the turn so the replacement can receive its own continuation.
      const complete = !slow && (revision
        ? revisionCalls <= 3 || hasReplacement
        : calls === 2) && options.tools?.some(tool => tool.name === "update_goal")
      if (complete && !goalRevision) throw new Error("The model did not receive a goal revision")
      if (revision) await appendFile(`${process.env.GOAL_SMOKE_COMPLETION_GATE}.requests`,
        JSON.stringify({ call: revisionCalls, hasReplacement, revision: goalRevision, complete }) + "\n")
      const parts = [{ type: "stream-start", warnings: [] }]
      if (complete) parts.push({ type: "tool-call", toolCallId: `goal-complete-${calls}`, toolName: "update_goal",
        input: JSON.stringify({ status: "complete", revision: goalRevision }) })
      else parts.push({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: `Smoke turn ${calls}` }, { type: "text-end", id: "t" })
      parts.push({ type: "finish", finishReason: { unified: complete ? "tool-calls" : "stop", raw: complete ? "tool_calls" : "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } })
      if ((!slow && !revision && calls > 5) || (revision && revisionCalls > 6))
        throw new Error("Smoke model loop exceeded limit; update_goal was not called")
      return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } }) }
    },
  }) }
}

export default Plugin.define({ id: "goal-test-provider", async setup(ctx) {
  const providerID = Provider.ID.make("goal-test")
  await ctx.provider.transform(editor => editor.add({
    info: { ...Provider.Info.empty(providerID), name: "Goal test (offline)", activation: "enabled", package: `aisdk:${import.meta.url}` },
    models: ["test", "slow", "revision"].map(id => Model.Info.default(providerID, Model.ID.make(id))),
  }))
  await ctx.model.transform(editor => editor.default.set("goal-test", "test"))
} })
