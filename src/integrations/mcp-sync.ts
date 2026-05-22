// Bridge between connectors and the MCP-server registry.
//
// Some providers (today only Linear) expose an HTTP MCP endpoint that the
// agent loop reaches through `mcp_call(server: "<name>", …)`. Connectors
// and MCP servers live in separate state slices, so authenticating a
// connector by itself never makes the matching MCP server resolvable. This
// module is the glue: whenever a provider's connector becomes usable, we
// materialize the provider-declared MCP server record (if one isn't
// already present).
//
// Kept separate from `mcp.ts` to avoid an import cycle with
// `./connectors/index.ts` (which calls `syncProviderMcpServers` from
// `checkConnector`). `mcp.ts` itself depends on `./connectors`, so
// importing back from there would create the cycle.

import type { RuntimeConfig } from "../types";
import { addAudit, createMcpServerRecord, mutateState, readState } from "../state";
import { getProvider } from "./connectors/registry";

// Idempotently materialize an MCP server record for every provider that
// declares one and has at least one configured + healthy connector. The
// registry is keyed by `mcpServer.name`: if a server with that name
// already exists (any status, including disabled), the upsert is a no-op
// so we never clobber a user's manual `gini mcp add` config.
//
// Called from:
//   - `checkConnector` (after a successful probe flips health to healthy)
//   - server startup (back-fill for connectors that pre-date this code)
//
// Returns the list of newly-created MCP server names so callers can log
// or audit the transition.
export async function syncProviderMcpServers(config: RuntimeConfig): Promise<string[]> {
  const state = readState(config.instance);
  const created: string[] = [];
  const providerIds = new Set(state.connectors.map((c) => c.provider));
  for (const providerId of providerIds) {
    const module = getProvider(providerId);
    if (!module?.mcpServer) continue;
    // Only register once a connector is actually usable. Mirrors the same
    // active-skill gate: `health: "unknown"` for a probe-based provider
    // hasn't run a real probe yet, so we defer.
    const hasProbe = Boolean(module.probe);
    const usable = state.connectors.find(
      (c) =>
        c.provider === providerId
        && c.status === "configured"
        && (c.health === "healthy" || (!hasProbe && c.health === "unknown"))
    );
    if (!usable) continue;
    const desired = module.mcpServer;
    // Name-based dedup: leave any existing entry (configured, disabled, or
    // error) alone. The user's manual config wins.
    if (state.mcpServers.some((s) => s.name === desired.name)) continue;
    await mutateState(config.instance, (mutating) => {
      // Re-check inside the lock to avoid a race with a concurrent CLI
      // `gini mcp add` that landed between our read and the mutate.
      if (mutating.mcpServers.some((s) => s.name === desired.name)) return;
      const record = createMcpServerRecord(mutating, {
        name: desired.name,
        command: "",
        args: [],
        envKeys: [],
        exposedTools: desired.exposedTools ?? [],
        transport: desired.transport ?? "http",
        url: desired.url,
        headers: desired.headers ? { ...desired.headers } : undefined
      });
      addAudit(
        mutating,
        {
          actor: "runtime",
          action: "mcp.auto_register",
          target: record.id,
          risk: "low",
          evidence: { provider: providerId, name: desired.name, url: desired.url }
        },
        { system: true }
      );
    });
    created.push(desired.name);
  }
  return created;
}
