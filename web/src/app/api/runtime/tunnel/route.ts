// Dedicated BFF route for `/api/tunnel`. The generic catch-all would proxy
// the upstream JSON verbatim, but that JSON contains the per-instance
// tunnel secret and the secret-bearing publicUrl — both of which are
// auth-bypass credentials. Per the project's token-isolation boundary
// (browser code must not receive gateway credentials), we redact those
// fields before the response leaves the BFF. The browser UI still gets
// everything it needs to display: cloudflareUrl (the bare host), the
// Apple Notes mirror status, observedAt, and lastError.

import { NextRequest } from "next/server";
import { runtimeToken, runtimeUrl } from "@/lib/runtime";
import { originHostMatchesRequest } from "./guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forwardRedacted(
  method: "GET" | "PATCH",
  body?: string
): Promise<Response> {
  // GET is strictly read-only. The Apple Notes resync trigger moved
  // to a sibling POST /api/runtime/tunnel/refresh-notes precisely so
  // SameSite=Lax cookies cannot attach on a cross-site GET and fire
  // osascript via CSRF. PATCH is mutate-only and accepts the same
  // narrow `{ enabled?, appleNotes? }` shape it always has.
  const upstream = await fetch(`${runtimeUrl()}/api/tunnel`, {
    method,
    headers: {
      authorization: `Bearer ${runtimeToken()}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {})
    },
    body
  });
  if (!upstream.ok) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" }
    });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await upstream.text());
  } catch {
    return new Response("{}", { status: 502, headers: { "content-type": "application/json" } });
  }
  const redacted = redactTunnelSnapshot(payload);
  return Response.json(redacted);
}

export function redactTunnelSnapshot(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  // Capture the raw secret-bearing values BEFORE we null them out below
  // so we can scrub any error strings that may have quoted them inline.
  // osascript surfaces AppleScript runtime errors with literal source
  // text — a failure touching the `body:` attribute can echo the
  // bodyHtml fragment carrying the publicUrl. The manager already
  // scrubs these strings before storing, but we run the same pass
  // here as defence in depth: a regression in the manager (or a new
  // error path that forgets to call sanitizeError) must not leak the
  // credential through this BFF.
  const rawSecrets: string[] = [];
  if (typeof record.publicUrl === "string" && record.publicUrl.length > 0) rawSecrets.push(record.publicUrl);
  if (typeof record.secret === "string" && record.secret.length > 0) rawSecrets.push(record.secret);
  if (typeof record.cloudflareUrl === "string" && record.cloudflareUrl.length > 0) rawSecrets.push(record.cloudflareUrl);
  // Allow-list projection. The upstream snapshot may grow new fields over
  // time; this DTO opts each safe field in explicitly so any new
  // credential-bearing field (e.g. a future signed-redirect URL) fails
  // closed — the browser receives nothing it wasn't approved to see.
  // `secret` and `publicUrl` are emitted as explicit nulls so legacy
  // clients can still check `!!secret` / `!!publicUrl` against the
  // expected shape.
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : null,
    publicUrl: null,
    cloudflareUrl: typeof record.cloudflareUrl === "string" ? record.cloudflareUrl : null,
    secret: null,
    targetUrl: typeof record.targetUrl === "string" ? record.targetUrl : null,
    observedAt: typeof record.observedAt === "string" ? record.observedAt : null,
    appleNotes: redactAppleNotes(record.appleNotes, rawSecrets),
    lastError: typeof record.lastError === "string"
      ? scrubSecrets(record.lastError, rawSecrets)
      : null
  };
}

function redactAppleNotes(
  payload: unknown,
  secrets: readonly string[]
): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : null,
    folder: typeof record.folder === "string" ? record.folder : null,
    noteName: typeof record.noteName === "string" ? record.noteName : null,
    available: typeof record.available === "boolean" ? record.available : null,
    lastSyncedAt: typeof record.lastSyncedAt === "string" ? record.lastSyncedAt : null,
    lastError: typeof record.lastError === "string"
      ? scrubSecrets(record.lastError, secrets)
      : null
  };
}

/**
 * Strip secret-bearing substrings from an error string. Mirrors the
 * manager-side `sanitizeError` so the BFF can't leak a credential even
 * if a future upstream error path forgets to sanitise. Exported so the
 * route's tests can pin the behaviour without spinning up the full
 * forward pipeline.
 */
export function scrubSecrets(message: string, secrets: readonly string[]): string {
  let result = message;
  let scrubbed = false;
  // Replace longest substrings first so the publicUrl (which contains
  // the bare secret) is scrubbed before its inner secret pass, which
  // would otherwise leave a `${cloudflareUrl}/` fragment behind.
  const candidates = secrets
    .filter((value) => typeof value === "string" && value.length > 0)
    .slice()
    .sort((a, b) => b.length - a.length);
  for (const value of candidates) {
    if (!result.includes(value)) continue;
    result = result.split(value).join("[redacted]");
    scrubbed = true;
  }
  if (scrubbed && !result.endsWith("(secret values redacted)")) {
    result = `${result} (secret values redacted)`;
  }
  return result;
}

export const GET = async (_request: NextRequest) => forwardRedacted("GET");

// PATCH toggles cloudflared and the Apple Notes mirror state. The BFF
// auto-injects the runtime bearer on every forward, so without an
// Origin/Referer guard a co-tenant process on localhost could POST
// `{enabled: true}` here and the runtime would spin cloudflared up —
// the operator never consented. The refresh-notes endpoint has the
// same shape; mirror its check rather than inventing a new policy.
// Legitimate callers (the Settings card same-origin fetch from the
// operator's own browser) always carry an Origin matching the Host;
// the CLI bypasses the BFF entirely and hits the runtime directly.
export const PATCH = async (request: NextRequest) => {
  if (!originHostMatchesRequest(request)) {
    return Response.json({ error: "Origin/Referer must match Host for tunnel mutations." }, { status: 403 });
  }
  let body = "";
  try { body = await request.text(); } catch { body = ""; }
  return forwardRedacted("PATCH", body || "{}");
};
