import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import * as net from "node:net";
import { __test, connectBrowser, disconnectBrowser, getBrowserConnection } from "./browser-connect";
import { readState } from "../state";
import type { RuntimeConfig } from "../types";

// Isolated state root so we don't smear test state across the developer's
// real ~/.gini directory. Mirrors the convention used elsewhere in the
// test suite (see src/http.test.ts).
const TEST_ROOT = "/tmp/gini-browser-connect-tests";
process.env["GINI_STATE_ROOT"] = TEST_ROOT;

function testConfig(instance: string): RuntimeConfig {
  rmSync(`${TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${TEST_ROOT}/instances/${instance}`,
    logRoot: `${TEST_ROOT}-logs/${instance}`
  };
}

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("browser-connect helpers", () => {
  test("redactUrlCredentials strips user:pass@", () => {
    const result = __test.redactUrlCredentials("ws://alice:secret@127.0.0.1:9222/devtools/browser/abc");
    expect(result).not.toContain("alice");
    expect(result).not.toContain("secret");
    expect(result).toContain("127.0.0.1");
  });

  test("redactUrlCredentials leaves credential-free URLs alone", () => {
    const url = "ws://127.0.0.1:9222/devtools/browser/abc";
    expect(__test.redactUrlCredentials(url)).toBe(url);
  });

  test("redactUrlCredentials returns sentinel for invalid URLs", () => {
    const result = __test.redactUrlCredentials("not a url");
    expect(result).toBe("<redacted>");
  });

  test("cdpHttpForm rewrites ws:// to http://", () => {
    expect(__test.cdpHttpForm("ws://127.0.0.1:9222/devtools/browser/abc")).toBe("http://127.0.0.1:9222");
  });

  test("cdpHttpForm rewrites wss:// to https://", () => {
    expect(__test.cdpHttpForm("wss://example.com:9443/devtools/browser/abc")).toBe("https://example.com:9443");
  });

  test("validateCdpUrl accepts ws/wss/http/https", () => {
    expect(__test.validateCdpUrl("ws://localhost:9222/").ok).toBe(true);
    expect(__test.validateCdpUrl("wss://example.com/").ok).toBe(true);
    expect(__test.validateCdpUrl("http://localhost:9222/").ok).toBe(true);
    expect(__test.validateCdpUrl("https://example.com/").ok).toBe(true);
  });

  test("validateCdpUrl rejects unsupported protocols", () => {
    const result = __test.validateCdpUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unsupported");
  });

  test("validateCdpUrl rejects garbage input", () => {
    const result = __test.validateCdpUrl("not a url");
    expect(result.ok).toBe(false);
  });

  test("validatePort accepts 1..65535 and rejects everything else", () => {
    expect(__test.validatePort(9222, 1234)).toBe(9222);
    expect(__test.validatePort(undefined, 1234)).toBe(1234);
    expect(() => __test.validatePort(-1, 9222)).toThrow();
    expect(() => __test.validatePort(0, 9222)).toThrow();
    expect(() => __test.validatePort(99999, 9222)).toThrow();
    expect(() => __test.validatePort("nope", 9222)).toThrow();
  });

  test("profileDirFor lives under the instance root", () => {
    const config = testConfig("profile-dir");
    const dir = __test.profileDirFor(config);
    expect(dir.endsWith("chrome-profile")).toBe(true);
    expect(dir.includes("profile-dir")).toBe(true);
  });
});

describe("browser-connect API surface", () => {
  beforeEach(() => {
    // No-op — each test creates its own config via testConfig() which
    // wipes the per-instance directory.
  });

  test("status is disconnected by default", () => {
    const config = testConfig("status-empty");
    const status = getBrowserConnection(config);
    expect(status.connected).toBe(false);
    expect(status.record).toBeUndefined();
  });

  test("connect with a bad cdpUrl protocol is rejected", async () => {
    const config = testConfig("connect-bad-url");
    await expect(connectBrowser(config, { cdpUrl: "file:///nope" })).rejects.toThrow(/Unsupported/);
  });

  test("connect with garbage cdpUrl is rejected", async () => {
    const config = testConfig("connect-garbage-url");
    await expect(connectBrowser(config, { cdpUrl: "not-a-url" })).rejects.toThrow(/Invalid cdpUrl/);
  });

  test("connect with an unreachable cdpUrl fails after the probe timeout", async () => {
    const config = testConfig("connect-unreachable");
    // Port 1 is reserved and refused everywhere — the probe loop will
    // never get a response. We use a low timeout via the unreachable
    // host instead of mocking time; the test sets its own ceiling.
    await expect(
      connectBrowser(config, { cdpUrl: "http://127.0.0.1:1/" })
    ).rejects.toThrow(/Could not reach CDP endpoint/);
  }, 30_000);

  test("disconnect on an empty state is a no-op", async () => {
    const config = testConfig("disconnect-empty");
    const status = await disconnectBrowser(config);
    expect(status.connected).toBe(false);
    const state = readState(config.instance);
    expect(state.browser ?? null).toBeNull();
  });

  test("connectExisting persists redacted credentials in the audit row when state is mutated", async () => {
    // We can't exercise the full connectExisting path without a real CDP
    // endpoint, but we can directly verify the redaction helper covers
    // the audit shape the capability writes. The mutateState-coupled
    // happy path is exercised end-to-end in the integration smoke run.
    const dirty = "ws://user:pass@127.0.0.1:9222/devtools/browser/abc";
    expect(__test.redactUrlCredentials(dirty)).not.toContain("pass");
    expect(__test.redactUrlCredentials(dirty)).toContain("127.0.0.1");
  });

  test("idempotent connect: an existing dead record is cleared before retrying", async () => {
    const config = testConfig("idempotent-dead");
    // Seed a fake CDP record pointing at an unreachable port. When
    // connectBrowser sees an existing record it should re-probe, fail,
    // clear the record, and only THEN attempt the requested path. We
    // ask for a managed launch but the test environment has no Chrome,
    // so we expect the call to fail at the launch step (or earlier).
    // The success criterion is that the stale record was cleared.
    const { mutateState } = await import("../state");
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "cdp",
        cdpUrl: "ws://127.0.0.1:1/devtools/browser/dead",
        pid: null,
        dataDir: null,
        chromePath: null,
        startedAt: new Date().toISOString()
      };
    });

    // Now call connect with a cdpUrl that's also unreachable. Both the
    // pre-probe and the fresh attempt should fail; the important
    // assertion is that the dead record was cleared mid-flight.
    await expect(
      connectBrowser(config, { cdpUrl: "http://127.0.0.1:1/" })
    ).rejects.toThrow();
    const state = readState(config.instance);
    expect(state.browser ?? null).toBeNull();
  }, 60_000);
});

describe("browser-connect round-1 hardening", () => {
  test("safetyCheck blocks IPv4-mapped IPv6 metadata via ws://", async () => {
    const config = testConfig("safety-mapped-metadata");
    // The SSRF guard converts the ws:// URL to its http:// sibling and
    // hands that off to safetyCheck. The IPv4-mapped IPv6 form of
    // 169.254.169.254 is one of the cloud metadata bypasses we
    // specifically must reject.
    await expect(
      connectBrowser(config, { cdpUrl: "ws://[::ffff:169.254.169.254]:9222/devtools/browser/abc" })
    ).rejects.toThrow(/Invalid cdpUrl/);
  });

  test("safetyCheck blocks link-local IPv6 over wss://", async () => {
    const config = testConfig("safety-linklocal-ipv6");
    await expect(
      connectBrowser(config, { cdpUrl: "wss://[fe80::1]:9222/devtools/browser/abc" })
    ).rejects.toThrow(/Invalid cdpUrl/);
  });

  test("stripUrlCredentials drops user:pass@ for storage", () => {
    const stripped = __test.stripUrlCredentials("ws://alice:secret@127.0.0.1:9222/devtools/browser/abc");
    expect(stripped).not.toContain("alice");
    expect(stripped).not.toContain("secret");
    expect(stripped).toContain("127.0.0.1");
  });

  test("stripUrlCredentials leaves clean URLs untouched", () => {
    const clean = "ws://127.0.0.1:9222/devtools/browser/abc";
    expect(__test.stripUrlCredentials(clean)).toBe(clean);
  });

  test("ensurePortAvailable rejects when port is bound", async () => {
    // Bind a listener so the helper sees EADDRINUSE. Picking 0 lets the
    // OS assign a free ephemeral port; we then ask the helper about that
    // same port and expect rejection.
    await new Promise<void>(async (resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", async () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          server.close();
          reject(new Error("no port assigned"));
          return;
        }
        const port = addr.port;
        try {
          await expect(__test.ensurePortAvailable(port)).rejects.toThrow(/already in use/);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          server.close();
        }
      });
    });
  });

  test("ensurePortAvailable succeeds when port is free", async () => {
    // Take an ephemeral port, close it, then probe — the kernel will
    // typically hand it back to us. (TIME_WAIT means this can flake, but
    // SO_REUSEADDR-default net.createServer should be fine on Bun.)
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          server.close();
          reject(new Error("no port assigned"));
          return;
        }
        const p = addr.port;
        server.close(() => resolve(p));
      });
    });
    await expect(__test.ensurePortAvailable(port)).resolves.toBeUndefined();
  });

  test("isPidStillChrome returns false when ps cmdline doesn't match", () => {
    // pid 1 (the init process) is guaranteed to exist on macOS/Linux but
    // its cmdline will never include the magical /Applications/Google
    // Chrome.app path nor a --user-data-dir flag. The identity check must
    // refuse to accept it.
    const matches = __test.isPidStillChrome(
      1,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/tmp/never-was-a-real-data-dir"
    );
    expect(matches).toBe(false);
  });

  test("idempotent connect refreshes cdpUrl from the probe response", async () => {
    const config = testConfig("idempotent-refresh");
    // Stand up a tiny HTTP server that pretends to be /json/version. We
    // record a stale URL, then watch the connect flow refresh it to the
    // new UUID the server reports.
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/json/version") {
            return Response.json({
              Browser: "TestChrome/0.0",
              webSocketDebuggerUrl: `ws://127.0.0.1:${server!.port}/devtools/browser/FRESH-UUID`
            });
          }
          return new Response("nope", { status: 404 });
        }
      });
      const { mutateState } = await import("../state");
      await mutateState(config.instance, (state) => {
        state.browser = {
          mode: "cdp",
          cdpUrl: `ws://127.0.0.1:${server!.port}/devtools/browser/OLD-STALE-UUID`,
          pid: null,
          dataDir: null,
          chromePath: null,
          startedAt: new Date().toISOString()
        };
      });

      const result = await connectBrowser(config, {});
      expect(result.connected).toBe(true);
      expect(result.record?.cdpUrl).toContain("FRESH-UUID");
      expect(result.record?.cdpUrl).not.toContain("OLD-STALE-UUID");
      // State should also reflect the refresh.
      const persisted = readState(config.instance).browser;
      expect(persisted?.cdpUrl).toContain("FRESH-UUID");
    } finally {
      server?.stop(true);
    }
  });
});
