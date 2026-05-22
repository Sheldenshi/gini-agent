// CLI surface for the Cloudflare quick-tunnel feature. Exposes the runtime's
// /api/tunnel endpoints to humans and persists config flips into the on-disk
// config.json so a future restart picks them up.

import { readFileSync, writeFileSync } from "node:fs";
import type { CliContext } from "../context";
import { api } from "../api";
import { print } from "../output";
import { configPath } from "../../paths";
import { generateSecret } from "../../integrations/tunnel";

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
    mutateTunnelConfig(ctx, (tunnelCfg) => ({ ...tunnelCfg, enabled: true }));
    print({ ok: true, message: "Tunnel enabled. Restart the runtime (`gini stop && gini start`) to pick up the change." });
    return;
  }

  if (sub === "disable") {
    mutateTunnelConfig(ctx, (tunnelCfg) => ({ ...tunnelCfg, enabled: false }));
    print({ ok: true, message: "Tunnel disabled. Restart the runtime to apply." });
    return;
  }

  if (sub === "rotate-secret") {
    const newSecret = generateSecret();
    mutateTunnelConfig(ctx, (tunnelCfg) => ({ ...tunnelCfg, secret: newSecret }));
    print({ ok: true, secret: newSecret, message: "Tunnel secret rotated. Restart the runtime to apply; the previous URL prefix becomes invalid immediately on next boot." });
    return;
  }

  if (sub === "sync-notes") {
    // No dedicated endpoint — the manager refreshes Apple Notes automatically
    // when the tunnel snapshot changes. We surface a hint and the current
    // status so the user can verify after a restart.
    const snapshot = await api(config, "/api/tunnel");
    print({
      ok: true,
      snapshot,
      message: "Apple Notes refresh happens automatically when the tunnel URL changes. Restart the runtime to force a fresh push."
    });
    return;
  }

  if (sub === "apple-notes") {
    const action = cliArgs[2];
    if (action === "enable") {
      mutateTunnelConfig(ctx, (tunnelCfg) => ({
        ...tunnelCfg,
        appleNotes: { ...tunnelCfg.appleNotes, enabled: true }
      }));
      print({ ok: true, message: "Apple Notes mirroring enabled. Restart the runtime to apply." });
      return;
    }
    if (action === "disable") {
      mutateTunnelConfig(ctx, (tunnelCfg) => ({
        ...tunnelCfg,
        appleNotes: { ...tunnelCfg.appleNotes, enabled: false }
      }));
      print({ ok: true, message: "Apple Notes mirroring disabled. Restart the runtime to apply." });
      return;
    }
    if (action === "folder") {
      const folder = cliArgs[3];
      if (!folder) throw new Error("Usage: gini tunnel apple-notes folder <folder-name>");
      mutateTunnelConfig(ctx, (tunnelCfg) => ({
        ...tunnelCfg,
        appleNotes: { ...tunnelCfg.appleNotes, folder }
      }));
      print({ ok: true, folder, message: "Apple Notes folder updated. Restart the runtime to apply." });
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

interface TunnelConfigShape {
  enabled?: boolean;
  secret?: string;
  appleNotes?: { enabled?: boolean; folder?: string; noteName?: string; account?: string };
}

function mutateTunnelConfig(
  ctx: CliContext,
  mutate: (tunnel: TunnelConfigShape) => TunnelConfigShape
): void {
  const path = configPath(ctx.config.instance);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const current = ((raw.tunnel ?? {}) as TunnelConfigShape);
  raw.tunnel = mutate({ ...current, appleNotes: { ...(current.appleNotes ?? {}) } });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}
