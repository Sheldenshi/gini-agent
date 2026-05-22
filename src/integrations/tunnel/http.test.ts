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
    expect(payload.publicUrl).toBe("https://example.trycloudflare.com/abcdefghij0123456789/");
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

  test("tunneled GET /<secret> (no trailing slash) also lands on the landing", async () => {
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
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
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
    publicUrl: "https://example.trycloudflare.com/abcdefghij0123456789/",
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
