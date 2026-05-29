// Server-only tunnel policy helpers. Reads the live tunnel config and the
// published public-URL host from disk on every call. Kept in a separate file
// from `tunnel-policy.ts` so the browser-bundled client code never pulls in
// `node:fs` / `node:os` / `node:path` (Turbopack would otherwise reject the
// bundle with `the chunking context (unknown) does not support external
// modules (request: node:fs)`).
//
// See docs/adr/tunnel-and-mobile-access.md "Architecture (summary)" and
// "Trust radius" + docs/adr/bff-trust-boundary.md.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// MUST stay in sync with TUNNEL_PUBLIC_URL_FILENAME in
// src/runtime/tunnel/types.ts. Inlined here because Next.js' Turbopack
// can't follow a tsconfig path alias across the worktree root in the
// middleware bundle, and TypeScript's web project rootDir refuses an
// absolute-style relative import that escapes web/. The runtime is the
// writer; this is the reader; renaming the file requires updating both.
const TUNNEL_PUBLIC_URL_FILENAME = "tunnel.publicUrl";

function instanceStateDir(): string {
  const instance = process.env.GINI_INSTANCE ?? "default";
  const stateRoot = process.env.GINI_STATE_ROOT
    ? resolve(process.env.GINI_STATE_ROOT)
    : join(process.env.HOME ?? homedir(), ".gini");
  return join(stateRoot, "instances", instance);
}

/** Read the live tunnel config from disk on every call. The proxy reads
 *  tunnel.secret + tunnel.enabled uncached on every request so rotate-secret
 *  / disable cycles invalidate cookies on the very next hit without
 *  coordination. See docs/adr/tunnel-and-mobile-access.md
 *  "Architecture (summary)". */
export function readTunnelConfigFromDisk(): { enabled: boolean; secret: string } {
  const configFile = join(instanceStateDir(), "config.json");
  if (!existsSync(configFile)) return { enabled: false, secret: "" };
  try {
    const raw = readFileSync(configFile, "utf8");
    const parsed = JSON.parse(raw) as { tunnel?: { enabled?: unknown; secret?: unknown } };
    return {
      enabled: parsed.tunnel?.enabled === true,
      secret: typeof parsed.tunnel?.secret === "string" ? parsed.tunnel.secret : ""
    };
  } catch {
    return { enabled: false, secret: "" };
  }
}

/** Read the live tunnel public URL host from the sibling file the runtime
 *  publishes (`~/.gini/instances/<inst>/tunnel.publicUrl`). The proxy uses
 *  this for an EQUALITY host match (see
 *  docs/adr/tunnel-and-mobile-access.md "Architecture (summary)"),
 *  rather than a permissive `.trycloudflare.com` suffix check. Returns the
 *  empty string when the file is missing (no live tunnel) — the proxy
 *  treats that as "no tunnel branch matches" and rejects at the Host
 *  classifier. */
export function readLiveTunnelHost(): string {
  const p = join(instanceStateDir(), TUNNEL_PUBLIC_URL_FILENAME);
  if (!existsSync(p)) return "";
  try {
    const url = readFileSync(p, "utf8").trim();
    if (!url) return "";
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}
