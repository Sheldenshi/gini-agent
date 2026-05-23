// CLI surface for the Cloudflare quick-tunnel feature. Exposes the runtime's
// /api/tunnel endpoints to humans and persists config flips into the on-disk
// config.json so a future restart picks them up.

import { readFileSync, writeFileSync } from "node:fs";
import type { CliContext } from "../context";
import { api } from "../api";
import { print } from "../output";
import { configPath, writeConfigAtomic } from "../../paths";
import { generateSecret } from "../../integrations/tunnel";
import type { PersistedTunnelConfig } from "../../types";

export async function tunnel(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "status";

  if (sub === "status") {
    const snapshot = await api(config, "/api/tunnel");
    print(snapshot);
    return;
  }

  if (sub === "qr") {
    // Hit the runtime over HTTP so the CLI works against any reachable
    // instance, not just the local one. Falls back to a clear message
    // when the tunnel hasn't produced a URL yet.
    const response = await fetch(`http://127.0.0.1:${config.port}/api/tunnel/qr.txt`, {
      headers: { authorization: `Bearer ${config.token}` }
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const message = (payload as { error?: string }).error ?? `HTTP ${response.status}`;
      throw new Error(message);
    }
    const ansi = await response.text();
    const snapshot = await api(config, "/api/tunnel");
    process.stdout.write(`${ansi}\n`);
    if ((snapshot as { publicUrl?: string }).publicUrl) {
      process.stdout.write(`${(snapshot as { publicUrl?: string }).publicUrl}\n`);
    }
    return;
  }

  if (sub === "enable") {
    const snapshot = await applyTunnelToggle(ctx, { enabled: true });
    if (snapshot) {
      print({ ok: true, snapshot, message: "Tunnel enabled. cloudflared is starting now." });
    } else {
      mutateTunnelConfig(ctx, (tunnelCfg) => ({ ...tunnelCfg, enabled: true }));
      print({ ok: true, message: "Tunnel enabled in config.json. Start the runtime (`gini start`) to bring cloudflared up." });
    }
    return;
  }

  if (sub === "disable") {
    const snapshot = await applyTunnelToggle(ctx, { enabled: false });
    if (snapshot) {
      print({ ok: true, snapshot, message: "Tunnel disabled. cloudflared has been torn down." });
    } else {
      mutateTunnelConfig(ctx, (tunnelCfg) => ({ ...tunnelCfg, enabled: false }));
      print({ ok: true, message: "Tunnel disabled in config.json. The runtime is not currently running." });
    }
    return;
  }

  if (sub === "rotate-secret") {
    // Secret rotation stays disk-only: the PATCH /api/tunnel surface
    // intentionally accepts only `enabled` + `appleNotes.enabled` so an
    // attacker holding the bearer cannot rotate the secret out from
    // under a paired device. The CLI runs locally, owns config.json,
    // and the running gateway captured the OLD secret at boot — so the
    // rotation only takes effect after a restart. Mention that in the
    // message instead of pretending the live runtime has rotated.
    const newSecret = generateSecret();
    mutateTunnelConfig(ctx, (tunnelCfg) => ({ ...tunnelCfg, secret: newSecret }));
    print({ ok: true, secret: newSecret, message: "Tunnel secret rotated in config.json. Restart the runtime to apply; the previous URL prefix becomes invalid immediately on next boot." });
    return;
  }

  if (sub === "sync-notes") {
    // Explicit re-sync trigger. GET /api/tunnel is read-only by default
    // (so the web Settings card's 5s poll doesn't queue osascript
    // subprocesses); passing `?refreshNotes=1` is the documented
    // contract for the operator's "I just granted Automation
    // permission" flow.
    const snapshot = await api(config, "/api/tunnel?refreshNotes=1");
    print({
      ok: true,
      snapshot,
      message: "Apple Notes refresh triggered. Check the snapshot's appleNotes.lastSyncedAt / lastError for the result."
    });
    return;
  }

  if (sub === "apple-notes") {
    const action = cliArgs[2];
    if (action === "enable") {
      const snapshot = await applyTunnelToggle(ctx, { appleNotes: { enabled: true } });
      if (snapshot) {
        print({ ok: true, snapshot, message: "Apple Notes mirroring enabled." });
      } else {
        mutateTunnelConfig(ctx, (tunnelCfg) => ({
          ...tunnelCfg,
          appleNotes: { ...tunnelCfg.appleNotes, enabled: true }
        }));
        print({ ok: true, message: "Apple Notes mirroring enabled in config.json. Start the runtime to apply." });
      }
      return;
    }
    if (action === "disable") {
      const snapshot = await applyTunnelToggle(ctx, { appleNotes: { enabled: false } });
      if (snapshot) {
        print({ ok: true, snapshot, message: "Apple Notes mirroring disabled." });
      } else {
        mutateTunnelConfig(ctx, (tunnelCfg) => ({
          ...tunnelCfg,
          appleNotes: { ...tunnelCfg.appleNotes, enabled: false }
        }));
        print({ ok: true, message: "Apple Notes mirroring disabled in config.json. Start the runtime to apply." });
      }
      return;
    }
    if (action === "folder") {
      // Folder name isn't part of the PATCH /api/tunnel surface (which
      // accepts only enable toggles). It stays disk-only, picked up at
      // the next restart. The message reflects that contract.
      const folder = cliArgs[3];
      if (!folder) throw new Error("Usage: gini tunnel apple-notes folder <folder-name>");
      mutateTunnelConfig(ctx, (tunnelCfg) => ({
        ...tunnelCfg,
        appleNotes: { ...tunnelCfg.appleNotes, folder }
      }));
      print({ ok: true, folder, message: "Apple Notes folder updated in config.json. Restart the runtime to apply." });
      return;
    }
    throw new Error(
      "Usage: gini tunnel apple-notes <enable|disable|folder> [...]"
    );
  }

  throw new Error(
    "Usage: gini tunnel <status|qr|enable|disable|rotate-secret|sync-notes|apple-notes ...>"
  );
}

// The mutator receives a normalized `appleNotes` slot so callers don't
// have to guard `current.appleNotes ?? {}` at every assignment site.
type WritableTunnelConfig = PersistedTunnelConfig & {
  appleNotes: NonNullable<PersistedTunnelConfig["appleNotes"]>;
};

function mutateTunnelConfig(
  ctx: CliContext,
  mutate: (tunnel: WritableTunnelConfig) => PersistedTunnelConfig
): void {
  const path = configPath(ctx.config.instance);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const current = (raw.tunnel ?? {}) as PersistedTunnelConfig;
  const normalized: WritableTunnelConfig = {
    ...current,
    appleNotes: { ...(current.appleNotes ?? {}) }
  };
  raw.tunnel = mutate(normalized);
  writeConfigAtomic(ctx.config.instance, raw);
}

// Prefer the live runtime PATCH path so a `gini tunnel enable` against a
// running gateway brings cloudflared up immediately (and the inverse
// disable tears it down) without waiting for a restart. We probe with a
// short-timeout GET /api/tunnel; if the runtime is reachable, hand the
// update over to its applyConfig hook which serializes through
// pendingApply in src/server.ts. If the gateway is not running, return
// null so the caller falls back to the direct disk mutation — same
// disk shape, same key set, so the next start picks up where the
// runtime would have left off.
async function applyTunnelToggle(
  ctx: CliContext,
  update: { enabled?: boolean; appleNotes?: { enabled?: boolean } }
): Promise<unknown | null> {
  const { config } = ctx;
  // Short-circuit on a quick probe so an offline runtime fails fast
  // instead of blocking on the full PATCH timeout. /api/status is
  // bearer-token gated AND in-memory, so a healthy gateway answers
  // sub-ms on localhost.
  try {
    const probe = await fetch(`http://127.0.0.1:${config.port}/api/status`, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(750)
    });
    if (!probe.ok) return null;
  } catch {
    return null;
  }
  try {
    return await api(config, "/api/tunnel", {
      method: "PATCH",
      body: JSON.stringify(update)
    });
  } catch {
    return null;
  }
}
