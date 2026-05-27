import type { CliContext } from "../context";
import { restAfter } from "../args";
import { api } from "../api";
import { print } from "../output";
import { bootstrapUrl, renderQrAnsi } from "../../runtime/tunnel";
import type { TunnelSnapshot } from "../../runtime/tunnel/types";

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

export async function tunnel(ctx: CliContext): Promise<void> {
  const { config, cliArgs } = ctx;
  const sub = cliArgs[1] ?? "status";

  switch (sub) {
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
