import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { GoalState } from "./core.ts"

export function parseGoal(value: unknown): GoalState | undefined {
  if (!value || typeof value !== "object") return
  const g = value as GoalState
  if (typeof g.objective !== "string" || !g.objective.trim()) return
  if (!["active", "paused", "complete"].includes(g.status)) return
  if (![g.createdAt, g.updatedAt, g.timeUsedSeconds].every(x => typeof x === "number" && Number.isFinite(x) && x >= 0)) return
  if (g.status === "active"
    ? typeof g.activeStartedAt !== "number" || !Number.isFinite(g.activeStartedAt) || g.activeStartedAt < 0
    : g.activeStartedAt !== null) return
  return { objective: g.objective, status: g.status, createdAt: g.createdAt, updatedAt: g.updatedAt,
    timeUsedSeconds: g.timeUsedSeconds, activeStartedAt: g.activeStartedAt }
}

// Read-only compatibility with the original 0.4.3 state file. V2 never writes it.
export async function loadLegacy(scope: string): Promise<Map<string, GoalState>> {
  const hash = createHash("sha256").update(scope).digest("hex").slice(0, 16)
  const root = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  const file = process.env.OPENCODE_GOAL_STATE_FILE || join(root, "opencode-goal", `scope_${hash}`, "sessions.json")
  try {
    const data = JSON.parse(await readFile(file, "utf8"))
    if (!data || typeof data !== "object" || Array.isArray(data)) return new Map()
    return new Map(Object.entries(data).flatMap(([id, value]) => {
      const goal = parseGoal(value)
      return goal ? [[id, goal] as const] : []
    }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("opencode-goal: cannot import legacy state", error)
    return new Map()
  }
}
