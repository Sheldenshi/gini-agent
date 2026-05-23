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
    // Secret rotation stays disk-only: PATCH /api/tunnel intentionally
    // accepts only `enabled` + `appleNotes.enabled`, so an attacker
    // holding the bearer can't rotate the secret out from under a
    // paired device. The CLI runs locally and owns config.json.
    //
    // But: the CLI's disk write races the runtime's serialized PATCH
    // chain. While the runtime is up, two read-modify-write paths
    // touch the same `tunnel.secret` slot — a PATCH enable mid-flight
    // can read the pre-rotation secret, write it back after the CLI
    // rotation, and silently undo the rotation. Refuse to rotate
    // while the runtime is reachable. The operator's workflow is:
    //
    //   bun run gini stop
    //   bun run gini tunnel rotate-secret
    //   bun run gini start
    //
    // Three commands but no in-memory/on-disk divergence at any
    // point.
    let runtimeReachable = true;
    try {
      await api(config, "/api/tunnel");
    } catch (error) {
      // Only treat ECONNREFUSED as "really offline" — a slow or
      // hanging runtime would otherwise classify itself as offline
      // on any transient error and let us proceed with a destructive
      // disk write that races the live in-memory state.
      runtimeReachable = !isConnectionRefused(error);
    }
    if (runtimeReachable) {
      throw new Error(
        "Refusing to rotate the tunnel secret while the runtime is running. Run `gini stop` first to avoid racing the runtime's in-memory tunnel state, then `gini tunnel rotate-secret`, then `gini start`."
      );
    }
    const newSecret = generateSecret();
    mutateTunnelConfig(ctx, (tunnelCfg) => ({ ...tunnelCfg, secret: newSecret }));
    print({
      ok: true,
      secret: newSecret,
      message: "Tunnel secret rotated in config.json. Next `gini start` will mint a QR / Apple Notes entry under the new secret."
    });
    return;
  }

  if (sub === "sync-notes") {
    // Explicit re-sync trigger. The endpoint is POST (not GET) so
    // SameSite=Lax tunnel cookies do not attach to it on cross-site
    // navigation — the resync would otherwise be a CSRF target since
    // it shells out to osascript on the operator's machine.
    const snapshot = await api(config, "/api/tunnel/refresh-notes", { method: "POST" });
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
      // accepts only enable toggles). The disk write would race the
      // runtime's serialized PATCH chain — an in-flight enable/disable
      // can read disk, then we write `folder`, then the runtime writes
      // back its pre-folder snapshot and silently clobbers our change.
      // Refuse the mutation while the runtime is reachable; the
      // operator's workflow is `gini stop` → folder change → `gini
      // start`. Atomic writes don't help here because the race is on
      // the read-modify-write window, not the file syscall.
      const folder = cliArgs[3];
      if (!folder) throw new Error("Usage: gini tunnel apple-notes folder <folder-name>");
      let runtimeReachable = true;
      try {
        await api(config, "/api/tunnel");
      } catch (error) {
        // Same shape as rotate-secret: only treat ECONNREFUSED as
        // truly offline so a slow runtime can't mask the race.
        runtimeReachable = !isConnectionRefused(error);
      }
      if (runtimeReachable) {
        throw new Error(
          "Refusing to update the Apple Notes folder while the runtime is running. Run `gini stop` first, then `gini tunnel apple-notes folder <name>`, then `gini start`. The PATCH surface does not accept folder changes, so the disk write would race the runtime's in-memory state."
        );
      }
      mutateTunnelConfig(ctx, (tunnelCfg) => ({
        ...tunnelCfg,
        appleNotes: { ...tunnelCfg.appleNotes, folder }
      }));
      print({ ok: true, folder, message: "Apple Notes folder updated in config.json. Next `gini start` will pick it up." });
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
// disable tears it down) without waiting for a restart. We attempt the
// PATCH directly: if the runtime is reachable, its applyConfig hook
// serializes through pendingApply in src/server.ts. If the gateway
// process is not running at all (ECONNREFUSED), return null so the
// caller falls back to a direct disk mutation — same disk shape,
// same key set, so the next start picks up where the runtime would
// have left off.
//
// We deliberately do NOT short-circuit on a separate /api/status
// probe with a tight timeout: a slow or still-booting runtime would
// trip the timeout, classify itself as offline, and disk-mutate
// while the runtime is actually up — splitting on-disk config from
// the live TunnelManager. Distinguishing ECONNREFUSED from other
// errors at PATCH time means a hanging runtime surfaces a real
// error instead of silently bypassing the serialized chain.
function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as Error & { cause?: { code?: string } }).cause;
  if (cause && typeof cause.code === "string" && cause.code === "ECONNREFUSED") return true;
  return /ECONNREFUSED|connection refused|fetch failed/i.test(error.message);
}

async function applyTunnelToggle(
  ctx: CliContext,
  update: { enabled?: boolean; appleNotes?: { enabled?: boolean } }
): Promise<unknown | null> {
  const { config } = ctx;
  try {
    return await api(config, "/api/tunnel", {
      method: "PATCH",
      body: JSON.stringify(update)
    });
  } catch (error) {
    if (isConnectionRefused(error)) return null;
    throw error;
  }
}
