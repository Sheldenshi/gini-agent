import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";
import { bootstrapUrl, renderQrAnsi } from "../../runtime/tunnel";
import type { TunnelSnapshot } from "../../runtime/tunnel/types";
import { ensureCloudflaredBin, manualInstallHint, CloudflaredUnavailableError } from "../../runtime/tunnel/cloudflared-install";

function asSnapshot(value: unknown): TunnelSnapshot {
  return value as TunnelSnapshot;
}

// gini tunnel <subcommand>
//   status              snapshot
//   qr                  ANSI QR for current bootstrap URL
//   enable              start cloudflared
//   disable             stop cloudflared
//   rotate-secret       mint a fresh 192-bit secret atomically
//   sync-notes          force an Apple Notes refresh
//   apple-notes [on|off]  enable/disable the iCloud Notes mirror
//
// All subcommands talk to the running runtime HTTP API. The gateway must be
// up — start it with `gini run` (or `gini start` in daemon mode) first.

const HELP_TEXT = `Usage: gini tunnel <subcommand>

Subcommands:
  status                   Print the current tunnel snapshot (default).
  qr                       Render an ASCII QR for the bootstrap URL and the URL itself.
  enable                   Spawn cloudflared, mint a bootstrap URL, and persist intent.
  disable                  Stop cloudflared and clear the bootstrap URL.
  rotate-secret            Mint a fresh 192-bit secret atomically and recycle cloudflared.
  sync-notes               Force the iCloud Notes mirror to refresh now.
  apple-notes <on|off>     Toggle the iCloud Notes mirror.
  install-cloudflared      Download/resolve the cloudflared binary now (no running gateway needed).

cloudflared is provisioned automatically on the first \`enable\` (and pre-fetched
by scripts/install.sh), so no manual package-manager install is required.
`;

export async function tunnel(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "status";

  if (sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(HELP_TEXT);
    return;
  }

  switch (sub) {
    case "install-cloudflared": {
      // Local + gateway-independent: resolve (downloading if needed) the
      // cloudflared binary so a later `enable` is instant. Called best-effort
      // by scripts/install.sh right after `bun install`. Unlike the other
      // subcommands this does NOT hit the runtime HTTP API — it runs the same
      // ensureCloudflaredBin() the manager uses, writing into ~/.gini/bin.
      try {
        const bin = await ensureCloudflaredBin();
        print({ ok: true, cloudflared: bin });
      } catch (err) {
        const hint = err instanceof CloudflaredUnavailableError ? err.hint : manualInstallHint();
        print({ ok: false, error: err instanceof Error ? err.message : String(err), install: hint });
        process.exitCode = 1;
      }
      return;
    }
    case "status": {
      const snap = asSnapshot(await api(config, "/api/tunnel"));
      print(snap);
      return;
    }
    case "qr": {
      const snap = asSnapshot(await api(config, "/api/tunnel"));
      if (!snap.publicUrl || !snap.secret) {
        throw new Error("Tunnel not enabled. Run `gini tunnel enable` first.");
      }
      const url = bootstrapUrl(snap.publicUrl, snap.secret);
      process.stdout.write(`${renderQrAnsi(url)}\n${url}\n`);
      return;
    }
    case "enable": {
      const snap = await api(config, "/api/tunnel", {
        method: "PATCH",
        body: JSON.stringify({ enabled: true })
      });
      print(snap);
      return;
    }
    case "disable": {
      const snap = await api(config, "/api/tunnel", {
        method: "PATCH",
        body: JSON.stringify({ enabled: false })
      });
      print(snap);
      return;
    }
    case "rotate-secret": {
      const snap = await api(config, "/api/tunnel", {
        method: "PATCH",
        body: JSON.stringify({ rotateSecret: true })
      });
      print(snap);
      return;
    }
    case "sync-notes": {
      const snap = await api(config, "/api/tunnel/refresh-notes", { method: "POST" });
      print(snap);
      return;
    }
    case "apple-notes": {
      const action = restAfter(cliArgs, sub)[0];
      if (action !== "on" && action !== "off") {
        throw new Error("Usage: gini tunnel apple-notes <on|off>");
      }
      const snap = await api(config, "/api/tunnel", {
        method: "PATCH",
        body: JSON.stringify({ appleNotes: { enabled: action === "on" } })
      });
      print(snap);
      return;
    }
    default:
      throw new Error(`Unknown subcommand: gini tunnel ${sub}`);
  }
}
