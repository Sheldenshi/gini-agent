import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createHandler } from "../../http";
import type { RuntimeConfig } from "../../types";
import type { TunnelSnapshot } from "./manager";

describe("tunnel HTTP integration", () => {
  test("tunneled requests bypass bearer-token auth", async () => {
    const config = testConfig("tunnel-http-bypass");
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot()
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/abcdefghij0123456789/api/status")
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toHaveProperty("instance", config.instance);
  });

  test("requests with the wrong secret path do not reach API routes", async () => {
    const config = testConfig("tunnel-http-bad-secret");
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot()
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/wrong-secret-here/api/status")
    );
    // 404 is the correct response — the wrong-secret prefix never strips, so
    // the effective pathname starts with "/wrong-secret-here" and falls
    // through to the catch-all not-found branch instead of hitting any
    // /api/* route. This pins the no-bypass-by-prefix-shape contract.
    expect(response.status).toBe(404);
  });

  test("direct /api requests without a bearer are 401 even when a tunnel secret is configured", async () => {
    const config = testConfig("tunnel-http-direct-no-token");
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot()
      }
    });
    const response = await handler(new Request("http://127.0.0.1:7337/api/status"));
    expect(response.status).toBe(401);
  });

  test("bearer-token requests still work when no tunnel secret is configured", async () => {
    const config = testConfig("tunnel-http-bearer");
    const handler = createHandler(config);
    const response = await handler(
      new Request("http://127.0.0.1:7337/api/status", {
        headers: { authorization: `Bearer ${config.token}` }
      })
    );
    expect(response.status).toBe(200);
  });

  test("GET /api/tunnel returns the snapshot when called with bearer token", async () => {
    const config = testConfig("tunnel-http-snapshot");
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot()
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/api/tunnel", {
        headers: { authorization: `Bearer ${config.token}` }
      })
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as TunnelSnapshot;
    expect(payload.publicUrl).toBe("https://example.trycloudflare.com/abcdefghij0123456789");
  });

  test("GET /api/tunnel invokes refreshAppleNote when the hook is provided", async () => {
    const config = testConfig("tunnel-http-refresh");
    let refreshes = 0;
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot(),
        refreshAppleNote: async () => {
          refreshes += 1;
          return { ...stubSnapshot(), appleNotes: { ...stubSnapshot().appleNotes, lastSyncedAt: "2026-02-02T00:00:00Z" } };
        }
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/api/tunnel", {
        headers: { authorization: `Bearer ${config.token}` }
      })
    );
    expect(response.status).toBe(200);
    expect(refreshes).toBe(1);
    const payload = (await response.json()) as TunnelSnapshot;
    expect(payload.appleNotes.lastSyncedAt).toBe("2026-02-02T00:00:00Z");
  });

  test("GET /api/tunnel falls back to snapshot when refreshAppleNote throws", async () => {
    const config = testConfig("tunnel-http-refresh-failure");
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot(),
        refreshAppleNote: async () => { throw new Error("permission denied"); }
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/api/tunnel", {
        headers: { authorization: `Bearer ${config.token}` }
      })
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as TunnelSnapshot;
    expect(payload.publicUrl).toBe("https://example.trycloudflare.com/abcdefghij0123456789");
  });

  test("PATCH /api/tunnel with { enabled: true } invokes applyConfig and returns the new snapshot", async () => {
    const config = testConfig("tunnel-http-patch-enable");
    const calls: Array<{ enabled?: boolean; appleNotes?: { enabled?: boolean } }> = [];
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot(),
        applyConfig: async (update) => {
          calls.push(update);
          return { ...stubSnapshot(), publicUrl: "https://example.trycloudflare.com/abcdefghij0123456789" };
        }
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/api/tunnel", {
        method: "PATCH",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true })
      })
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as TunnelSnapshot;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ enabled: true });
    expect(payload.publicUrl).toBe("https://example.trycloudflare.com/abcdefghij0123456789");
  });

  test("PATCH /api/tunnel with { appleNotes: { enabled } } forwards the nested shape verbatim", async () => {
    const config = testConfig("tunnel-http-patch-notes");
    const calls: Array<{ enabled?: boolean; appleNotes?: { enabled?: boolean } }> = [];
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot(),
        applyConfig: async (update) => {
          calls.push(update);
          return stubSnapshot();
        }
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/api/tunnel", {
        method: "PATCH",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ appleNotes: { enabled: false } })
      })
    );
    expect(response.status).toBe(200);
    expect(calls[0]).toEqual({ appleNotes: { enabled: false } });
  });

  test("PATCH /api/tunnel ignores non-boolean fields silently", async () => {
    // Defensive: the toggle component only ever sends booleans, but a
    // hand-rolled curl could pass a string. The runtime treats those as
    // no-ops rather than throwing.
    const config = testConfig("tunnel-http-patch-typesafe");
    const calls: Array<{ enabled?: boolean; appleNotes?: { enabled?: boolean } }> = [];
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot(),
        applyConfig: async (update) => {
          calls.push(update);
          return stubSnapshot();
        }
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/api/tunnel", {
        method: "PATCH",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: "true", appleNotes: { enabled: 1 } })
      })
    );
    expect(response.status).toBe(200);
    expect(calls[0]).toEqual({});
  });

  test("PATCH /api/tunnel returns 501 when applyConfig hook is absent", async () => {
    const config = testConfig("tunnel-http-patch-501");
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot()
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/api/tunnel", {
        method: "PATCH",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true })
      })
    );
    expect(response.status).toBe(501);
  });

  test("GET /api/tunnel/qr.svg returns an SVG image", async () => {
    const config = testConfig("tunnel-http-qr-svg");
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot()
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/api/tunnel/qr.svg", {
        headers: { authorization: `Bearer ${config.token}` }
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    const body = await response.text();
    expect(body.startsWith("<svg")).toBe(true);
  });

  test("GET /api/tunnel/qr.svg returns 404 when no URL is available", async () => {
    const config = testConfig("tunnel-http-qr-404");
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => ({ ...stubSnapshot(), publicUrl: null })
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/api/tunnel/qr.svg", {
        headers: { authorization: `Bearer ${config.token}` }
      })
    );
    expect(response.status).toBe(404);
  });

  test("tunneled GET / returns the friendly HTML landing", async () => {
    const config = testConfig("tunnel-http-landing");
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot()
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/abcdefghij0123456789/")
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Gini gateway");
    expect(html).toContain(config.instance);
    expect(html).toContain("api/status");
  });

  test("tunneled GET /<secret> (no trailing slash) 301s to the slash form", async () => {
    const config = testConfig("tunnel-http-no-slash");
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => "abcdefghij0123456789",
        getSnapshot: () => stubSnapshot()
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/abcdefghij0123456789")
    );
    // The relative links on the landing page (`./api/status`, etc.)
    // would resolve against `/` if we served the landing directly at
    // `/<secret>`, dropping the secret prefix. Redirecting first means
    // every browser hits the landing with the URL bar already showing
    // `/<secret>/` so subsequent navigation works.
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toContain("/abcdefghij0123456789/");
  });

  test("getSecret returning null disables the secret-path bypass entirely", async () => {
    const config = testConfig("tunnel-http-disabled-secret");
    // Simulates a runtime where the tunnel feature is disabled but a
    // secret is still persisted on disk. Any request that previously
    // would have matched the bypass now falls through to the regular
    // bearer-token check.
    const handler = createHandler(config, {
      tunnel: {
        getSecret: () => null,
        getSnapshot: () => null
      }
    });
    const response = await handler(
      new Request("http://127.0.0.1:7337/abcdefghij0123456789/api/state")
    );
    expect(response.status).toBe(404);
    // Direct /api/* without bearer still 401.
    const bareApi = await handler(
      new Request("http://127.0.0.1:7337/api/state")
    );
    expect(bareApi.status).toBe(401);
  });
});

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-tunnel-http-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`,
    approvalMode: "auto"
  };
}

function stubSnapshot(): TunnelSnapshot {
  return {
    enabled: true,
    publicUrl: "https://example.trycloudflare.com/abcdefghij0123456789",
    cloudflareUrl: "https://example.trycloudflare.com",
    secret: "abcdefghij0123456789",
    targetUrl: "http://127.0.0.1:7337",
    observedAt: "2026-01-01T00:00:00Z",
    appleNotes: {
      enabled: false,
      folder: "gini",
      noteName: "tunnel-url",
      available: null,
      lastSyncedAt: null,
      lastError: null
    },
    lastError: null
  };
}
