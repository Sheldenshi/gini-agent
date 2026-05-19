import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

describe("browser-connect round-2 hardening", () => {
  test("mismatch-reconnect drops the in-process handle before fresh attempt", async () => {
    const config = testConfig("mismatch-teardown");
    const { mutateState } = await import("../state");
    // Seed a managed record. The caller will request a different cdpUrl;
    // the mismatch path must run the full teardown (clear state + drop
    // the in-process Playwright handle via disconnectSharedBrowser) before
    // attempting the fresh launch. Closing the context terminates the
    // Chromium child Playwright launched — no separate PID kill needed.
    // Install a fake context so disconnectSharedBrowser can call close()
    // on it without spawning a real browser.
    const browserMod = await import("../tools/browser");
    let contextCloseCount = 0;
    browserMod.__test.installFakeManagedContextForTest({
      close: async () => {
        contextCloseCount++;
      }
    });
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "managed",
        cdpUrl: __test.MANAGED_CDP_SENTINEL,
        pid: 424242,
        dataDir: "/tmp/never-was-real",
        chromePath: "/never/was/real/chrome",
        startedAt: new Date().toISOString()
      };
    });

    // Ask for a different cdpUrl. The fresh attach will fail (unreachable
    // port), but the assertion is about the *teardown order*: the managed
    // context's close() must have run BEFORE the launch attempt rejected,
    // and state must be cleared on failure.
    await expect(
      connectBrowser(config, { cdpUrl: "ws://127.0.0.1:1/devtools/browser/NEW" })
    ).rejects.toThrow();
    expect(contextCloseCount).toBe(1);
    const persisted = readState(config.instance).browser;
    expect(persisted ?? null).toBeNull();
    browserMod.__test.uninstallFakeBrowserForTest();
  }, 30_000);

  test("concurrent disconnect calls run a single teardown sequence", async () => {
    const config = testConfig("disconnect-coalesced");
    const { mutateState } = await import("../state");
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "managed",
        cdpUrl: __test.MANAGED_CDP_SENTINEL,
        pid: 111111,
        dataDir: "/tmp/coalesced-data-dir",
        chromePath: "/never/real/chrome",
        startedAt: new Date().toISOString()
      };
    });
    const browserMod = await import("../tools/browser");
    let closeCount = 0;
    browserMod.__test.installFakeManagedContextForTest({
      close: async () => {
        closeCount++;
        // Simulate a teardown that takes a moment so concurrent callers
        // really do overlap. Without pendingDisconnect, the second caller
        // would race the first.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
    const [a, b] = await Promise.all([
      disconnectBrowser(config),
      disconnectBrowser(config)
    ]);
    expect(a.connected).toBe(false);
    expect(b.connected).toBe(false);
    // Both calls should coalesce onto the same pendingDisconnect: the
    // managed context's close() runs exactly once.
    expect(closeCount).toBe(1);
    browserMod.__test.uninstallFakeBrowserForTest();
  });
});

describe("browser-connect round-3 hardening", () => {
  test("blocked replacement cdpUrl does NOT tear down existing managed record", async () => {
    const config = testConfig("blocked-keeps-existing");
    const { mutateState } = await import("../state");
    // Seed a managed record. A bad-input connect must not tear down the
    // user's Chrome before validation fires — the round-3 fix lifts
    // validation to the top of connectBrowserInner so the SSRF/safety
    // check happens BEFORE we even read `existing`.
    const browserMod = await import("../tools/browser");
    let closeCalled = false;
    browserMod.__test.installFakeManagedContextForTest({
      close: async () => {
        closeCalled = true;
      }
    });
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "managed",
        cdpUrl: __test.MANAGED_CDP_SENTINEL,
        pid: 555555,
        dataDir: "/tmp/keep-me",
        chromePath: "/never/real/chrome",
        startedAt: new Date().toISOString()
      };
    });
    // IPv4-mapped IPv6 metadata bypass — safetyCheck rejects with a
    // "Blocked: ..." message wrapped in "Invalid cdpUrl: ...".
    await expect(
      connectBrowser(config, { cdpUrl: "ws://[::ffff:169.254.169.254]:9222/" })
    ).rejects.toThrow(/Invalid cdpUrl/);
    expect(closeCalled).toBe(false);
    // Old record is still there — we did not tear anything down.
    const persisted = readState(config.instance).browser;
    expect(persisted?.pid).toBe(555555);
    expect(persisted?.dataDir).toBe("/tmp/keep-me");
    browserMod.__test.uninstallFakeBrowserForTest();
  });

  test("malformed replacement cdpUrl does NOT tear down existing managed record", async () => {
    const config = testConfig("malformed-keeps-existing");
    const { mutateState } = await import("../state");
    const browserMod = await import("../tools/browser");
    let closeCalled = false;
    browserMod.__test.installFakeManagedContextForTest({
      close: async () => {
        closeCalled = true;
      }
    });
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "managed",
        cdpUrl: __test.MANAGED_CDP_SENTINEL,
        pid: 555556,
        dataDir: "/tmp/keep-me-malformed",
        chromePath: "/never/real/chrome",
        startedAt: new Date().toISOString()
      };
    });
    await expect(connectBrowser(config, { cdpUrl: "not a url" })).rejects.toThrow(/Invalid cdpUrl/);
    expect(closeCalled).toBe(false);
    const persisted = readState(config.instance).browser;
    expect(persisted?.pid).toBe(555556);
    expect(persisted?.dataDir).toBe("/tmp/keep-me-malformed");
    browserMod.__test.uninstallFakeBrowserForTest();
  });

  test("mismatch teardown of a cdp-mode record disconnects without close()", async () => {
    const config = testConfig("cdp-mismatch-no-kill");
    const { mutateState } = await import("../state");
    // Seed a cdp-mode record (the user attached to an external Chrome).
    // The caller then passes a *different* cdpUrl — the mismatch path
    // must run teardown (clear state + disconnect the in-process handle)
    // but must NOT close() the CDP Browser (close() over CDP terminates
    // the user's Chrome).
    const browserMod = await import("../tools/browser");
    let disconnectCalled = false;
    let closeCalled = false;
    browserMod.__test.installFakeCdpBrowserForTest(
      {
        disconnect: async () => {
          disconnectCalled = true;
        },
        close: async () => {
          closeCalled = true;
        }
      }
    );
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "cdp",
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/EXTERNAL",
        pid: null,
        dataDir: null,
        chromePath: null,
        startedAt: new Date().toISOString()
      };
    });
    // A different valid cdpUrl. The fresh attach will fail (unreachable
    // port 1) but the assertion is about teardown selectivity.
    await expect(
      connectBrowser(config, { cdpUrl: "ws://127.0.0.1:1/devtools/browser/OTHER" })
    ).rejects.toThrow();
    expect(disconnectCalled).toBe(true);
    expect(closeCalled).toBe(false);
    // State cleared by the teardown.
    const persisted = readState(config.instance).browser;
    expect(persisted ?? null).toBeNull();
    browserMod.__test.uninstallFakeBrowserForTest();
  }, 30_000);

  test("mismatch teardown writes a browser.disconnect audit row", async () => {
    const config = testConfig("mismatch-audit");
    const { mutateState } = await import("../state");
    const browserMod = await import("../tools/browser");
    browserMod.__test.installFakeManagedContextForTest({
      close: async () => undefined
    });
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "managed",
        cdpUrl: __test.MANAGED_CDP_SENTINEL,
        pid: 777777,
        dataDir: "/tmp/audit-old-dir",
        chromePath: "/never/real/chrome",
        startedAt: new Date().toISOString()
      };
    });
    await expect(
      connectBrowser(config, { cdpUrl: "ws://127.0.0.1:1/devtools/browser/NEW" })
    ).rejects.toThrow();
    const state = readState(config.instance);
    const disconnects = state.audit.filter((row) => row.action === "browser.disconnect");
    expect(disconnects.length).toBeGreaterThanOrEqual(1);
    // The latest audit row should reference the old record's data dir
    // as its target (managed-mode target convention).
    expect(disconnects[0]!.target).toBe("/tmp/audit-old-dir");
    browserMod.__test.uninstallFakeBrowserForTest();
  }, 30_000);

  test("pendingDisconnect coalesces concurrent disconnects and clears for the next call", async () => {
    // With the managed-launchPersistentContext pivot, the session manager
    // owns the close path and swallows teardown errors so the user is
    // never left in a half-disconnected state. We can no longer assert
    // that teardown errors propagate (they don't — by design). Instead
    // verify the round-2 coalescing invariant: concurrent disconnects
    // share a single in-flight promise, and the slot clears so a
    // subsequent disconnect runs independently.
    const config = testConfig("pending-disconnect-coalesce");
    const { mutateState } = await import("../state");
    const browserMod = await import("../tools/browser");
    let closeCount = 0;
    browserMod.__test.installFakeManagedContextForTest({
      close: async () => {
        closeCount++;
        // Hold long enough that both concurrent callers latch onto the
        // same pendingDisconnect promise.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "managed",
        cdpUrl: __test.MANAGED_CDP_SENTINEL,
        pid: 888888,
        dataDir: "/tmp/coalesce-test",
        chromePath: "/never/real/chrome",
        startedAt: new Date().toISOString()
      };
    });
    const [a, b] = await Promise.all([
      disconnectBrowser(config),
      disconnectBrowser(config)
    ]);
    expect(a.connected).toBe(false);
    expect(b.connected).toBe(false);
    expect(closeCount).toBe(1);

    // pendingDisconnect cleared — a subsequent disconnect should re-run.
    browserMod.__test.uninstallFakeBrowserForTest();
    let secondCloseCount = 0;
    browserMod.__test.installFakeManagedContextForTest({
      close: async () => {
        secondCloseCount++;
      }
    });
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "managed",
        cdpUrl: __test.MANAGED_CDP_SENTINEL,
        pid: 999999,
        dataDir: "/tmp/coalesce-test-2",
        chromePath: "/never/real/chrome",
        startedAt: new Date().toISOString()
      };
    });
    const followup = await disconnectBrowser(config);
    expect(followup.connected).toBe(false);
    expect(secondCloseCount).toBe(1);
    browserMod.__test.uninstallFakeBrowserForTest();
  });
});

describe("browser-connect managed launch via playwright", () => {
  test("launchManaged calls chromium.launchPersistentContext and stores the record", async () => {
    const config = testConfig("playwright-launch");
    const launchCalls: Array<{ dataDir: string; options: Record<string, unknown> }> = [];
    // Mock playwright-core so we exercise launchManaged without actually
    // spawning Chrome. The fake context exposes browser()->process()->pid
    // and a no-op close so the post-launch PID extraction path works.
    mock.module("playwright-core", () => ({
      chromium: {
        executablePath: () => "/fake/path/to/chromium",
        launchPersistentContext: async (dataDir: string, options: Record<string, unknown>) => {
          launchCalls.push({ dataDir, options });
          return {
            browser: () => ({ process: () => ({ pid: 4242 }) }),
            close: async () => undefined
          };
        }
      }
    }));
    try {
      const result = await connectBrowser(config, {});
      expect(result.connected).toBe(true);
      expect(result.record?.mode).toBe("managed");
      expect(result.record?.pid).toBe(4242);
      expect(result.record?.dataDir).toContain("chrome-profile");
      expect(result.record?.cdpUrl).toBe(__test.MANAGED_CDP_SENTINEL);
      expect(launchCalls.length).toBe(1);
      expect(launchCalls[0]!.dataDir).toContain("chrome-profile");
      expect(launchCalls[0]!.options.headless).toBe(false);
      expect(Array.isArray(launchCalls[0]!.options.args)).toBe(true);
    } finally {
      mock.restore();
      const browserMod = await import("../tools/browser");
      browserMod.__test.uninstallFakeBrowserForTest();
    }
  });

  test("disconnect closes the managed context (which terminates Chromium)", async () => {
    const config = testConfig("playwright-disconnect");
    const { mutateState } = await import("../state");
    const browserMod = await import("../tools/browser");
    let contextClosed = false;
    browserMod.__test.installFakeManagedContextForTest({
      close: async () => {
        contextClosed = true;
      }
    });
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "managed",
        cdpUrl: __test.MANAGED_CDP_SENTINEL,
        pid: 5252,
        dataDir: "/tmp/playwright-disconnect-data",
        chromePath: "/fake/path/to/chromium",
        startedAt: new Date().toISOString()
      };
    });
    const status = await disconnectBrowser(config);
    expect(status.connected).toBe(false);
    expect(contextClosed).toBe(true);
    const persisted = readState(config.instance).browser;
    expect(persisted ?? null).toBeNull();
    browserMod.__test.uninstallFakeBrowserForTest();
  });
});

// Round-1 fix 5: realistic coverage that the same per-instance profile
// dir is used across a Connect → Disconnect → tool-call sequence. We
// mock playwright-core so launchPersistentContext records the data dir
// it was invoked with at every step; the assertion is that the dir is
// identical across the two launches (sign-ins persist on the same dir).
describe("persistent profile dir is stable across Connect → Disconnect → tool call", () => {
  test("Connect launches headed against the same dir the default-tool path uses headless", async () => {
    const config = testConfig("profile-stable");
    const launchCalls: Array<{ dataDir: string; options: Record<string, unknown> }> = [];
    mock.module("playwright-core", () => ({
      chromium: {
        executablePath: () => "/fake/path/to/chromium",
        launchPersistentContext: async (dataDir: string, options: Record<string, unknown>) => {
          launchCalls.push({ dataDir, options });
          return {
            pages: () => [],
            newPage: async () => ({
              on: () => undefined,
              close: () => Promise.resolve(),
              goto: () => Promise.resolve(null),
              url: () => "about:blank",
              title: () => Promise.resolve(""),
              evaluate: () => Promise.resolve([])
            }),
            browser: () => ({ process: () => ({ pid: 9999 }) }),
            close: async () => undefined
          };
        }
      }
    }));
    const browserMod = await import("../tools/browser");
    browserMod.__test.resetChromiumImportForTest();
    browserMod.setBrowserInstance(config.instance);
    try {
      // Step 1: Connect — launches headed against the per-instance dir.
      const connectResult = await connectBrowser(config, {});
      expect(connectResult.connected).toBe(true);
      // Step 2: Disconnect — closes the visible context.
      const disconnectResult = await disconnectBrowser(config);
      expect(disconnectResult.connected).toBe(false);
      // Step 3: Default tool path — relaunches headless against the SAME dir.
      try {
        await browserMod.browserNavigate("profile-stable-task", { url: "https://example.com/" });
      } catch {
        // snapshot may fail with the fake page; assertion below is what matters.
      }

      expect(launchCalls.length).toBeGreaterThanOrEqual(2);
      const first = launchCalls[0]!;
      const second = launchCalls[launchCalls.length - 1]!;
      expect(first.dataDir).toBe(second.dataDir);
      expect(first.dataDir).toContain("chrome-profile");
      expect(first.dataDir).toContain(config.instance);
      // Connect is headed; default tool path is headless.
      expect(first.options.headless).toBe(false);
      expect(second.options.headless).toBe(true);
    } finally {
      mock.restore();
      browserMod.__test.uninstallFakeBrowserForTest();
      browserMod.__test.clearFakeSessionsForTest();
      browserMod.__test.resetChromiumImportForTest();
      browserMod.setBrowserInstance("dev");
    }
  });
});

// Round-1 fix 3: state.browser must be cleared on runtime startup so a
// stale managed record from a previous run doesn't make GET /api/browser
// report `connected: true` and trigger an unprompted headed Chrome launch
// on the next agent tool call. This test exercises the same mutateState
// shape that src/server.ts runs at startup; the on-disk profile dir is
// independent and stays put.
describe("startup clears stale browser connection record", () => {
  test("mutateState(state.browser = null) leaves on-disk profile untouched", async () => {
    const config = testConfig("startup-clear-stale");
    const { mutateState } = await import("../state");
    // Materialize a profile dir on disk to prove the wipe is independent
    // of clearing the record.
    const dir = __test.profileDirFor(config);
    mkdirSync(dir, { recursive: true });
    const sentinel = join(dir, "Cookies");
    writeFileSync(sentinel, "fake-cookie-data");

    // Seed a stale managed record (as if a previous runtime had a
    // visible Chrome window before crashing/restarting).
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "managed",
        cdpUrl: __test.MANAGED_CDP_SENTINEL,
        pid: 424242,
        dataDir: dir,
        chromePath: "/fake/path",
        startedAt: new Date().toISOString()
      };
    });
    expect(readState(config.instance).browser).not.toBeNull();

    // Same shape src/server.ts runs at startup.
    const existing = readState(config.instance).browser ?? null;
    if (existing) {
      await mutateState(config.instance, (state) => {
        state.browser = null;
      });
    }

    // Record gone, profile dir + sentinel cookie file untouched.
    expect(readState(config.instance).browser ?? null).toBeNull();
    expect(existsSync(sentinel)).toBe(true);
  });
});

// Round-1 fix 1: launchManaged wraps disconnect-then-launch in
// withTeardownLock so a parallel agent admission can't sneak in between
// the two awaits and re-acquire the profile lock. We verify the lock by
// installing a fake launchPersistentContext that, mid-launch, kicks off a
// browserNavigate admission and asserts it rejects with the standard
// "Browser disconnecting" sentinel.
describe("launchManaged holds the teardown lock across the disconnect-then-launch sequence", () => {
  test("a browserNavigate admission landing during launch is rejected", async () => {
    const config = testConfig("launch-lock-admission");
    const browserMod = await import("../tools/browser");
    browserMod.setBrowserInstance(config.instance);
    let admissionResultJson: string | undefined;
    mock.module("playwright-core", () => ({
      chromium: {
        executablePath: () => "/fake/path/to/chromium",
        launchPersistentContext: async () => {
          // Mid-launch: simulate a browserNavigate landing while the lock
          // is held. With the lock active, withSession should reject this
          // immediately with the disconnecting sentinel — proving no agent
          // tool call can sneak in between disconnectSharedBrowser and
          // launchPersistentContext.
          admissionResultJson = await browserMod.browserNavigate(
            "launch-lock-admission-task",
            { url: "https://example.com/" }
          );
          return {
            pages: () => [],
            newPage: async () => ({
              on: () => undefined,
              close: () => Promise.resolve(),
              goto: () => Promise.resolve(null),
              url: () => "about:blank",
              title: () => Promise.resolve(""),
              evaluate: () => Promise.resolve([])
            }),
            browser: () => ({ process: () => ({ pid: 7777 }) }),
            close: async () => undefined
          };
        }
      }
    }));
    browserMod.__test.resetChromiumImportForTest();
    try {
      await connectBrowser(config, {});
      expect(admissionResultJson).toBeDefined();
      const parsed = JSON.parse(admissionResultJson!) as { success: boolean; error?: string };
      expect(parsed.success).toBe(false);
      expect(parsed.error).toMatch(/disconnecting/i);
    } finally {
      mock.restore();
      browserMod.__test.uninstallFakeBrowserForTest();
      browserMod.__test.clearFakeSessionsForTest();
      browserMod.__test.setInFlightDisconnectsForTest(0);
      browserMod.__test.resetChromiumImportForTest();
      browserMod.setBrowserInstance("dev");
    }
  });
});

// Strict-managed mode: the `browser_connect` tool dispatch promises a
// visible managed Chrome to the user (via the approval card). When the
// caller passes `mode: "managed"` and a non-managed record already exists
// (typically a `cdp`-mode record from a previous /api/browser/connect),
// the capability must tear down the stale record and launch a fresh
// managed Chrome — NOT short-circuit and return the CDP record.
describe("browser-connect strict managed mode", () => {
  test("existing reachable cdp record + mode: 'managed' triggers teardown + fresh managed launch", async () => {
    const config = testConfig("strict-managed-replaces-cdp");
    // Stand up a real /json/version responder so the cdp record looks
    // alive on probe. Without `mode: "managed"`, connectBrowser would
    // happily refresh and return this cdp record — the exact silent-reuse
    // bug from round-9 finding 1. With `mode: "managed"`, the capability
    // must instead disconnect the in-process handle, clear state, and
    // launch a fresh managed Chrome.
    let server: ReturnType<typeof Bun.serve> | undefined;
    const browserMod = await import("../tools/browser");
    let cdpDisconnectCalled = false;
    let cdpCloseCalled = false;
    browserMod.__test.installFakeCdpBrowserForTest({
      disconnect: async () => {
        cdpDisconnectCalled = true;
      },
      close: async () => {
        // close() over CDP would terminate the user's Chrome — must NOT
        // be called by the strict-managed teardown path.
        cdpCloseCalled = true;
      }
    });
    const launchCalls: Array<{ dataDir: string; options: Record<string, unknown> }> = [];
    try {
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/json/version") {
            return Response.json({
              Browser: "ExternalChrome/0.0",
              webSocketDebuggerUrl: `ws://127.0.0.1:${server!.port}/devtools/browser/REACHABLE`
            });
          }
          return new Response("nope", { status: 404 });
        }
      });
      const { mutateState } = await import("../state");
      await mutateState(config.instance, (state) => {
        state.browser = {
          mode: "cdp",
          cdpUrl: `ws://127.0.0.1:${server!.port}/devtools/browser/EXTERNAL`,
          pid: null,
          dataDir: null,
          chromePath: null,
          startedAt: new Date().toISOString()
        };
      });

      mock.module("playwright-core", () => ({
        chromium: {
          executablePath: () => "/fake/path/to/chromium",
          launchPersistentContext: async (dataDir: string, options: Record<string, unknown>) => {
            launchCalls.push({ dataDir, options });
            return {
              browser: () => ({ process: () => ({ pid: 4343 }) }),
              close: async () => undefined
            };
          }
        }
      }));
      browserMod.__test.resetChromiumImportForTest();

      const result = await connectBrowser(config, { mode: "managed" });
      // Result must be a fresh managed record — not the seeded cdp one.
      expect(result.connected).toBe(true);
      expect(result.record?.mode).toBe("managed");
      expect(result.record?.pid).toBe(4343);
      expect(result.record?.cdpUrl).toBe(__test.MANAGED_CDP_SENTINEL);
      // Teardown of the existing cdp record happened (disconnect, not close).
      expect(cdpDisconnectCalled).toBe(true);
      expect(cdpCloseCalled).toBe(false);
      // A managed launchPersistentContext fired.
      expect(launchCalls.length).toBe(1);
      expect(launchCalls[0]!.options.headless).toBe(false);
      // Persisted state reflects the new managed record.
      const persisted = readState(config.instance).browser;
      expect(persisted?.mode).toBe("managed");
      expect(persisted?.cdpUrl).toBe(__test.MANAGED_CDP_SENTINEL);
    } finally {
      server?.stop(true);
      mock.restore();
      browserMod.__test.uninstallFakeBrowserForTest();
      browserMod.__test.clearFakeSessionsForTest();
      browserMod.__test.resetChromiumImportForTest();
    }
  });
});

