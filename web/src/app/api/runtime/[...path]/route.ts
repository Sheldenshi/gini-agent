import { NextRequest } from "next/server";
import { proxyRequest, runtimeInstance, runtimeToken, runtimeUrl } from "@/lib/runtime";
import { canonicalFirstSegmentIsTunnel, canonicalSecondSegmentIsQrSvg } from "./canonical";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forward(request: NextRequest, params: Promise<{ path: string[] }>): Promise<Response> {
  const { path } = await params;
  // Defensive guard — Next.js routes static segments before catch-alls, but if
  // someone reorganizes the tree we want the healthz route to remain owned by
  // the local handler rather than being proxied to the runtime (which has no
  // such endpoint).
  if (path.length === 1 && path[0] === "__healthz") {
    return Response.json({ ok: true, service: "gini-web", instance: runtimeInstance() });
  }
  // Refuse to proxy anything under /api/runtime/tunnel/* by default. The
  // bare `/tunnel` route is handled by web/src/app/api/runtime/tunnel/route.ts
  // (which redacts the secret); any other tunnel path would forward the
  // gateway's unredacted JSON/text content (which contains the
  // secret-bearing URL) straight to browser JS. The dedicated route can
  // take precedence here even after percent-decoding (`%74unnel` etc.)
  // because we canonicalize segments and compare on the lowercase value.
  //
  // Exception: `tunnel/qr.svg` is allow-listed here. The SVG is a
  // rendered QR — its source URL is recoverable by anyone willing to
  // run a QR decoder, but the same UI surface displays the QR to the
  // operator so they can scan it. Hiding the SVG from browser JS while
  // also displaying it in the DOM is impossible; the trade-off is
  // documented in docs/adr/tunnel-and-icloud-pairing.md.
  if (canonicalFirstSegmentIsTunnel(path) && !canonicalSecondSegmentIsQrSvg(path)) {
    return Response.json(
      { error: "Tunnel endpoints are not proxied through the BFF. Use the gateway directly or `gini tunnel qr`." },
      { status: 404 }
    );
  }
  return proxyRequest(request, path, {
    runtimeUrl: runtimeUrl(),
    token: runtimeToken(),
    signal: request.signal
  });
}

export const GET = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const POST = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const PATCH = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const DELETE = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
export const PUT = (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => forward(request, ctx.params);
