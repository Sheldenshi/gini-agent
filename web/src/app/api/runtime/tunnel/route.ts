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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forwardRedacted(method: "GET"): Promise<Response> {
  const upstream = await fetch(`${runtimeUrl()}/api/tunnel`, {
    method,
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
  const redacted = redactTunnelSnapshot(payload);
  return Response.json(redacted);
}

export function redactTunnelSnapshot(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  // Strip the secret and the secret-bearing publicUrl. Leave cloudflareUrl
  // (the bare host without the prefix) so the UI can render a label. The
  // QR rendering uses /api/runtime/tunnel/qr.svg, which is a binary
  // resource the browser displays as <img> but does not extract a string
  // from in normal flows.
  const copy: Record<string, unknown> = { ...record };
  if ("secret" in copy) copy.secret = null;
  if ("publicUrl" in copy) copy.publicUrl = null;
  return copy;
}

export const GET = async (_request: NextRequest) => forwardRedacted("GET");
