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

import type { ConnectorRecord, RuntimeConfig } from "../types";
import { addAudit, createMcpServerRecord, mutateState, readState } from "../state";
import { getProvider } from "./connectors/registry";

// A connector is "usable" for auto-register iff it is configured and has
// either confirmed healthy (probe ran) or — for probe-less providers —
// has unknown health (no remote check exists). Anything else (disabled,
// error, or unknown for a probe-based provider) defers registration so a
// stale or never-probed credential can't be promoted to an MCP entry.
function findUsableConnector(connectors: ConnectorRecord[], providerId: string, hasProbe: boolean): ConnectorRecord | undefined {
  return connectors.find(
    (c) =>
      c.provider === providerId
      && c.status === "configured"
      && (c.health === "healthy" || (!hasProbe && c.health === "unknown"))
  );
}

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
// or audit the transition. Names only appear in the return list when the
// insert actually happened inside the lock (i.e. no concurrent CLI add /
// connector disable raced ahead between our read and the mutate).
export async function syncProviderMcpServers(config: RuntimeConfig): Promise<string[]> {
  const state = readState(config.instance);
  const created: string[] = [];
  const providerIds = new Set(state.connectors.map((c) => c.provider));
  for (const providerId of providerIds) {
    const module = getProvider(providerId);
    if (!module?.mcpServer) continue;
    const hasProbe = Boolean(module.probe);
    // Cheap pre-check outside the lock to skip providers that obviously
    // have no usable connector. Authoritative check runs again inside the
    // mutateState callback so a concurrent disable/delete can't slip a
    // configured row past us.
    if (!findUsableConnector(state.connectors, providerId, hasProbe)) continue;
    const desired = module.mcpServer;
    if (state.mcpServers.some((s) => s.name === desired.name)) continue;
    const inserted = await mutateState(config.instance, (mutating): { id: string; name: string } | undefined => {
      // Re-check usability and existence inside the lock so we don't race
      // with a concurrent `gini mcp add`, a connector delete that wiped
      // the credential, or a `connector.disable` that flipped the row's
      // status between our read and write.
      const stillUsable = findUsableConnector(mutating.connectors, providerId, hasProbe);
      if (!stillUsable) return undefined;
      if (mutating.mcpServers.some((s) => s.name === desired.name)) return undefined;
      const record = createMcpServerRecord(
        mutating,
        {
          name: desired.name,
          command: "",
          args: [],
          envKeys: [],
          exposedTools: desired.exposedTools ?? [],
          transport: desired.transport ?? "http",
          url: desired.url,
          headers: desired.headers ? { ...desired.headers } : undefined
        },
        { actor: "runtime" }
      );
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
      return { id: record.id, name: record.name };
    });
    if (inserted) created.push(inserted.name);
  }
  return created;
}
