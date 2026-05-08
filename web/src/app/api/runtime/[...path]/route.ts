import { NextRequest } from "next/server";
import { proxyRequest, runtimeInstance, runtimeToken, runtimeUrl } from "@/lib/runtime";

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
