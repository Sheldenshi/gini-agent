// The /api/pairing route wrapper is a thin Next handler: resolve the catch-all
// segments, then hand off to proxyPairingRequest with the resolved gateway URL.
// These tests pin the GET + POST entry points and the params/runtimeUrl wiring;
// the forwarding behavior itself is covered by pairing-proxy.test.ts.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

const realProxy = await import("@/lib/pairing-proxy");
const realRuntime = await import("@/lib/runtime");

const forwarded: { path: string[]; runtimeUrl: string }[] = [];

let GET: (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
let POST: (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;

beforeAll(async () => {
  mock.module("@/lib/pairing-proxy", () => ({
    ...realProxy,
    proxyPairingRequest: async (_req: Request, path: string[], opts: { runtimeUrl: string }) => {
      forwarded.push({ path, runtimeUrl: opts.runtimeUrl });
      return Response.json({ ok: true });
    }
  }));
  mock.module("@/lib/runtime", () => ({
    ...realRuntime,
    runtimeUrl: () => "http://127.0.0.1:9999"
  }));
  // Cache-bust suffix in a variable so tsc doesn't try to resolve the path.
  const routePath = "./route?pairing-route-test";
  const mod = (await import(routePath)) as typeof import("./route");
  ({ GET, POST } = mod);
});

afterAll(() => {
  mock.module("@/lib/pairing-proxy", () => realProxy);
  mock.module("@/lib/runtime", () => realRuntime);
});

describe("/api/pairing/[...path] route", () => {
  test("GET forwards the resolved path + gateway URL to proxyPairingRequest", async () => {
    const req = new NextRequest("http://127.0.0.1:7777/api/pairing/requests");
    const res = await GET(req, { params: Promise.resolve({ path: ["requests"] }) });
    expect(res.status).toBe(200);
    expect(forwarded.at(-1)).toEqual({ path: ["requests"], runtimeUrl: "http://127.0.0.1:9999" });
  });

  test("POST forwards multi-segment approve paths", async () => {
    const req = new NextRequest("http://127.0.0.1:7777/api/pairing/requests/preq_1/approve", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ path: ["requests", "preq_1", "approve"] }) });
    expect(res.status).toBe(200);
    expect(forwarded.at(-1)).toEqual({ path: ["requests", "preq_1", "approve"], runtimeUrl: "http://127.0.0.1:9999" });
  });
});
