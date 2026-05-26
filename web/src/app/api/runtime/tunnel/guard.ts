// Shared Origin/Host guard for tunnel mutation routes. Both
// `/api/runtime/tunnel` (PATCH) and `/api/runtime/tunnel/refresh-notes`
// (POST) auto-inject the runtime bearer, so a co-tenant process on
// localhost could otherwise drive osascript or flip the tunnel without
// the operator's consent. SameSite=Lax stops cross-site BROWSER POSTs,
// but not a same-host process. Requiring the request's Origin (or
// Referer fallback) to match its Host header closes that surface: the
// Settings card and any mobile browser hitting the tunnel both send
// same-origin Origin, while a hostile localhost service has no
// browser-set Origin and is rejected.
//
// Centralising the helper means a future tweak (e.g. allowing a
// configured allow-list of external origins) applies uniformly to
// every tunnel-mutation endpoint instead of drifting between copies.

import type { NextRequest } from "next/server";

export function originHostMatchesRequest(request: NextRequest): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  const originRaw = request.headers.get("origin") ?? request.headers.get("referer");
  if (!originRaw) return false;
  try {
    const origin = new URL(originRaw);
    // Match host (which can be `name:port`) against the parsed
    // origin's authority (host:port, with port elided when default).
    const originHost = origin.port
      ? `${origin.hostname}:${origin.port}`
      : origin.hostname;
    return originHost === host || origin.host === host;
  } catch {
    return false;
  }
}
