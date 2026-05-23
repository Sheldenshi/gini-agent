// POST trigger for the Apple Notes resync. This lives at its own path
// (instead of `?refreshNotes=1` on GET /api/tunnel) so that SameSite=Lax
// session cookies do NOT attach to a cross-site request — browsers only
// send Lax cookies on top-level GETs, and the resync is side-effecting
// (osascript pipeline on the operator's macOS host). Keeping the
// trigger as POST closes the CSRF surface that the GET-query form had.
//
// Response is the redacted tunnel snapshot, same shape as
// `/api/runtime/tunnel` so the Settings card can swap the freshly
// returned snapshot into its React Query cache without reshaping.

import { runtimeToken, runtimeUrl } from "@/lib/runtime";
import { redactTunnelSnapshot } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = async (): Promise<Response> => {
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
