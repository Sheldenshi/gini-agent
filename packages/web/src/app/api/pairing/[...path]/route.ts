import { NextRequest } from "next/server";
import { proxyPairingRequest } from "@/lib/pairing-proxy";
import { runtimeUrl } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bridge the Next origin's same-origin /api/pairing/* calls to the gateway's
// native pairing surface (see web/src/lib/pairing-proxy.ts). Pairing uses only
// GET (list / poll) and POST (request / approve / reject / claim / cancel).
async function forward(request: NextRequest, params: Promise<{ path: string[] }>): Promise<Response> {
  const { path } = await params;
  return proxyPairingRequest(request, path, {
    runtimeUrl: runtimeUrl(),
    signal: request.signal
  });
}

export const GET = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const POST = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
