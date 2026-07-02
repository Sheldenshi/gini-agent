import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";

// `gini tunnel` — thin shim over the gateway's /api/tunnel routes. Every
// route returns the full TunnelState, so each sub-command just prints what
// the gateway returns.
//
//   gini tunnel                      -> GET  /api/tunnel (status + selection)
//   gini tunnel select <provider>    -> POST /api/tunnel/select { provider }
//   gini tunnel connect [provider]   -> POST /api/tunnel/connect { provider? }
//   gini tunnel cancel               -> POST /api/tunnel/cancel
//   gini tunnel disconnect           -> POST /api/tunnel/disconnect
//
// The CLI goes through the gateway (same source of truth as the web/MCP
// clients), never poking storage directly.
export async function tunnel(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "status";
  if (sub === "select") {
    const provider = restAfter(cliArgs, sub)[0];
    if (!provider) throw new Error("Usage: gini tunnel select <provider>");
    print(await api(config, "/api/tunnel/select", { method: "POST", body: JSON.stringify({ provider }) }));
    return;
  }
  if (sub === "connect") {
    const provider = restAfter(cliArgs, sub)[0];
    const payload = provider ? { provider } : {};
    print(await api(config, "/api/tunnel/connect", { method: "POST", body: JSON.stringify(payload) }));
    return;
  }
  if (sub === "cancel") {
    print(await api(config, "/api/tunnel/cancel", { method: "POST" }));
    return;
  }
  if (sub === "disconnect") {
    print(await api(config, "/api/tunnel/disconnect", { method: "POST" }));
    return;
  }
  // Only the bare `gini tunnel` (or explicit `status`) prints state; an unknown
  // sub-verb is a typo, so reject it loudly instead of silently showing status.
  if (sub !== "status") {
    throw new Error(`Unknown tunnel subcommand: ${sub}. Use: status | select | connect | cancel | disconnect.`);
  }
  // detect=1: a status read is the operator looking at the catalog, so re-probe
  // the manual driver prerequisites (tailscale/ngrok/cloudflared) first.
  print(await api(config, "/api/tunnel?detect=1"));
}
