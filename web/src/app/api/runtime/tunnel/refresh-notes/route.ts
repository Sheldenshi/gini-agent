// POST trigger for the Apple Notes resync. Lives at its own path
// (instead of `?refreshNotes=1` on GET /api/tunnel) so that SameSite=Lax
// session cookies do not attach on a cross-site request — browsers
// only send Lax cookies on top-level GETs, and the resync is
// side-effecting (osascript pipeline on the operator's macOS host).
// Keeping the trigger as POST closes the cross-site CSRF surface that
// the GET-query form had.
//
// SameSite=Lax stops cross-site BROWSER POSTs, but a co-tenant
// process running on localhost can still issue a credentialed POST
// directly. The BFF auto-injects the runtime bearer on every
// forward, so without an extra guard a hostile localhost service
// would happily fire osascript on the operator's host. We require
// the request's Origin (or Referer fallback) to match the request
// Host — every legitimate caller (Settings card, mobile Safari on
// the tunnel) sends a same-origin Origin; the CLI bypasses the BFF
// entirely and hits the runtime directly with its own bearer.
//
// Response is the redacted tunnel snapshot, same shape as
// `/api/runtime/tunnel` so the Settings card can swap the freshly
// returned snapshot into its React Query cache without reshaping.

import { NextRequest } from "next/server";
import { runtimeToken, runtimeUrl } from "@/lib/runtime";
import { redactTunnelSnapshot } from "../route";
import { originHostMatchesRequest } from "../guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = async (request: NextRequest): Promise<Response> => {
  if (!originHostMatchesRequest(request)) {
    return Response.json({ error: "Origin/Referer must match Host for tunnel mutations." }, { status: 403 });
  }
  const upstream = await fetch(`${runtimeUrl()}/api/tunnel/refresh-notes`, {
    method: "POST",
    headers: { authorization: `Bearer ${runtimeToken()}` }
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
  return Response.json(redactTunnelSnapshot(payload));
};
