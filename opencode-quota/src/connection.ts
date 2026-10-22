import type { Credential } from "@opencode/plugin"
import { builtins } from "./builtins.ts"

type Connection = { type: string }

// OpenCode can map a built-in provider (notably OpenCode Go) onto a shared
// integration such as OpenCode Console. Prefer the provider's own integration
// so a saved Key is still used, then fall back to the provider mapping.
export function credentialCandidates(providerID: string, integrationID: string | undefined): readonly string[] {
  if (!integrationID) return []
  if (!builtins.has(providerID) || providerID === integrationID) return [integrationID]
  return [providerID, integrationID]
}

export async function resolveConnection<C extends Connection>(
  providerID: string,
  integrationID: string | undefined,
  connections: {
    active(integrationID: string): Promise<C | undefined>
    resolve(connection: C): Promise<Credential.Value | undefined>
  },
): Promise<Credential.Value | undefined> {
  for (const id of credentialCandidates(providerID, integrationID)) {
    const connection = await connections.active(id)
    if (connection?.type !== "credential") continue
    return connections.resolve(connection)
  }
}
