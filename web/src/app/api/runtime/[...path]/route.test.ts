// The /api/runtime catch-all is the live handler for GET /api/runtime/__healthz:
// underscore-prefixed App Router folders are private and never route, so the
// identity payload has to be served by the in-handler guard. This test invokes
// the imported GET directly — pinning ok/service/instance plus pid (serving
// worker, diagnostic), ppid (web tree identity, the gate's dev fallback), and
// buildSha (the served-build identity, the gate's primary prod completion
// signal — both consumed by web/src/components/UpdateGate.tsx) — so a
// route-resolution regression can't hide behind client-side fetch mocks.

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

const realRuntime = await import("@/lib/runtime");

let GET: (request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;

beforeAll(async () => {
  mock.module("@/lib/runtime", () => ({
    ...realRuntime,
    runtimeInstance: () => "test-instance"
  }));
  // Cache-bust suffix in a variable so tsc doesn't try to resolve the path.
  const routePath = "./route?runtime-route-test";
  const mod = (await import(routePath)) as typeof import("./route");
  ({ GET } = mod);
});

afterAll(() => {
  mock.module("@/lib/runtime", () => realRuntime);
});

const originalDistDir = process.env.GINI_DIST_DIR;
afterEach(() => {
  if (originalDistDir === undefined) delete process.env.GINI_DIST_DIR;
  else process.env.GINI_DIST_DIR = originalDistDir;
});

async function healthz(): Promise<Record<string, unknown>> {
  const req = new NextRequest("http://127.0.0.1:7777/api/runtime/__healthz");
  const res = await GET(req, { params: Promise.resolve({ path: ["__healthz"] }) });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("/api/runtime/[...path] route", () => {
  test("GET __healthz serves the web identity payload locally", async () => {
    delete process.env.GINI_DIST_DIR;
    const body = await healthz();
    expect(body).toEqual({
      ok: true,
      service: "gini-web",
      instance: "test-instance",
      pid: process.pid,
      ppid: process.ppid
    });
    expect(typeof body.pid).toBe("number");
    expect(typeof body.ppid).toBe("number");
  });

  test("GET __healthz reports buildSha when serving a sha-keyed production dist dir", async () => {
    process.env.GINI_DIST_DIR = ".next-prod-0123456789ab";
    const body = await healthz();
    expect(body.buildSha).toBe("0123456789ab");
  });

  test("GET __healthz omits buildSha for a dev dist dir or when unset", async () => {
    process.env.GINI_DIST_DIR = ".next-test-instance";
    expect("buildSha" in (await healthz())).toBe(false);

    delete process.env.GINI_DIST_DIR;
    expect("buildSha" in (await healthz())).toBe(false);
  });
});
