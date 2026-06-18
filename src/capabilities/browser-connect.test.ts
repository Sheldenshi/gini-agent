import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  __test,
  completeBrowserConnectSetup,
  connectBrowser,
  disconnectBrowser,
  getBrowserConnection
} from "./browser-connect";
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

// Two transports (issue #420): the DEFAULT spawned per-instance Chrome (no
// record; sign-in via the in-chat screencast, exercised through the HTTP route
// in src/http.test.ts) and `cdp` attach to the user's own external Chrome (a
// persisted state.browser record). The managed/visible-window mode was removed.
describe("browser-connect helpers", () => {
  test("profileDirFor lives under the instance root", () => {
    const config = testConfig("profile-dir");
    const dir = __test.profileDirFor(config);
    expect(dir.endsWith("chrome-profile")).toBe(true);
    expect(dir.includes("profile-dir")).toBe(true);
  });

  test("ensureProfileDir materializes the per-instance profile dir", () => {
    const config = testConfig("ensure-profile-dir");
    const dir = __test.ensureProfileDir(config);
    expect(existsSync(dir)).toBe(true);
    expect(dir.endsWith("chrome-profile")).toBe(true);
  });
});

describe("browser-connect API surface", () => {
  test("status reports the stable disconnected shape", () => {
    const config = testConfig("status-empty");
    const status = getBrowserConnection(config);
    expect(status.connected).toBe(false);
  });

  test("connect with no cdpUrl is a no-op acknowledgement that writes no record", async () => {
    const config = testConfig("connect-noop");
    const status = await connectBrowser(config, {});
    expect(status.connected).toBe(false);
    // No state record for the default spawned transport.
    expect(readState(config.instance).browser ?? null).toBeNull();
  });

  test("disconnect drops the in-process handle and reports disconnected", async () => {
    const config = testConfig("disconnect-empty");
    const status = await disconnectBrowser(config);
    expect(status.connected).toBe(false);
    expect(readState(config.instance).browser ?? null).toBeNull();
  });

  test("disconnect tears down the live spawned handle without touching the profile", async () => {
    const config = testConfig("disconnect-live-handle");
    const browserMod = await import("../tools/browser");
    browserMod.setBrowserInstance(config.instance);
    // Materialize a profile dir + sentinel cookie to prove disconnect leaves
    // on-disk sign-ins intact.
    const dir = __test.ensureProfileDir(config);
    const sentinel = join(dir, "Cookies");
    writeFileSync(sentinel, "fake-cookie-data");
    let contextClosed = false;
    browserMod.__test.installFakeSpawnedHandleForTest(9333, {
      close: async () => {
        contextClosed = true;
      }
    });
    try {
      const status = await disconnectBrowser(config);
      expect(status.connected).toBe(false);
      expect(contextClosed).toBe(true);
      // The on-disk profile (and its cookies) survive the disconnect.
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      browserMod.__test.uninstallFakeBrowserForTest();
      // Reset the module-level instance to undefined rather than restoring a
      // hard-coded "dev" — leaving a non-default instance set would leak into
      // sibling tests that import the browser module and read it.
      browserMod.__test.resetBrowserInstanceForTest();
    }
  });
});

// CDP attach: the user points the runtime at their OWN external Chrome over a
// CDP websocket URL. Validation + redaction are pure; the connect path probes
// /json/version (we stub fetch / shrink the deadline so tests stay fast).
describe("cdp attach", () => {
  test("validateCdpUrl accepts ws/wss/http/https and rejects junk + bad protocols", () => {
    expect(__test.validateCdpUrl("ws://127.0.0.1:9222/devtools/browser/abc")).toEqual({
      ok: true,
      url: "ws://127.0.0.1:9222/devtools/browser/abc"
    });
    const bad = __test.validateCdpUrl("not a url");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("Invalid cdpUrl");
    const proto = __test.validateCdpUrl("file:///etc/passwd");
    expect(proto.ok).toBe(false);
    if (!proto.ok) expect(proto.error).toContain("Unsupported cdpUrl protocol");
  });

  test("cdpHttpForm maps ws->http and wss->https for the probe; falls back on garbage", () => {
    expect(__test.cdpHttpForm("ws://127.0.0.1:9222/devtools/browser/abc")).toBe("http://127.0.0.1:9222");
    expect(__test.cdpHttpForm("wss://example.test:9333/x")).toBe("https://example.test:9333");
    // Unparseable input falls back to the raw string (caller already validated).
    expect(__test.cdpHttpForm("::: not a url :::")).toBe("::: not a url :::");
  });

  test("stripUrlCredentials / redactUrlCredentials drop embedded basic-auth and survive garbage", () => {
    expect(__test.stripUrlCredentials("ws://alice:secret@127.0.0.1:9222/x")).toBe("ws://127.0.0.1:9222/x");
    expect(__test.redactUrlCredentials("ws://alice:secret@127.0.0.1:9222/x")).toBe("ws://127.0.0.1:9222/x");
    expect(__test.redactUrlCredentials("not a url")).toBe("<redacted>");
    // No credentials → unchanged; unparseable → strip returns the raw input.
    expect(__test.stripUrlCredentials("ws://127.0.0.1:9222/x")).toBe("ws://127.0.0.1:9222/x");
    expect(__test.stripUrlCredentials("::: bad :::")).toBe("::: bad :::");
  });

  test("connect short-circuits to the live existing record when the same endpoint is still reachable", async () => {
    const config = testConfig("cdp-reconnect-live");
    const { mutateState, now } = await import("../state");
    await mutateState(config.instance, (state) => {
      state.browser = { mode: "cdp", cdpUrl: "ws://127.0.0.1:9222/devtools/browser/existing", startedAt: now() };
    });
    const originalFetch = globalThis.fetch;
    let probes = 0;
    globalThis.fetch = (async () => {
      probes++;
      return new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/existing" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    try {
      // Same host as the persisted record → re-probe once and return the
      // existing record without re-writing it.
      const status = await connectBrowser(config, { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/different-path" });
      expect(status.connected).toBe(true);
      expect(status.record?.cdpUrl).toBe("ws://127.0.0.1:9222/devtools/browser/existing");
      // No second browser.connect audit row — the existing record was reused.
      const rows = readState(config.instance).audit.filter((r) => r.action === "browser.connect");
      expect(rows.length).toBe(0);
      expect(probes).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("same-host reconnect refreshes a stale ws path from the probe (Chrome restarted, new guid)", async () => {
    const config = testConfig("cdp-reconnect-refresh");
    const { mutateState, now } = await import("../state");
    await mutateState(config.instance, (state) => {
      // Stored path carries the OLD browser guid.
      state.browser = { mode: "cdp", cdpUrl: "ws://127.0.0.1:9222/devtools/browser/OLD-guid", startedAt: now() };
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      // The restarted Chrome answers on the same host:port with a NEW guid.
      new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/NEW-guid" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as unknown as typeof fetch;
    try {
      const status = await connectBrowser(config, { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/anything" });
      expect(status.connected).toBe(true);
      // The record (and persisted state) is refreshed to the new ws path so the
      // next connectOverCDP doesn't attach to the dead old guid.
      expect(status.record?.cdpUrl).toBe("ws://127.0.0.1:9222/devtools/browser/NEW-guid");
      expect(readState(config.instance).browser?.cdpUrl).toBe("ws://127.0.0.1:9222/devtools/browser/NEW-guid");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("bare connect (no cdpUrl) clears an active cdp record so tools fall back to the spawned default", async () => {
    const config = testConfig("cdp-bare-connect-clears");
    const { mutateState, now } = await import("../state");
    await mutateState(config.instance, (state) => {
      state.browser = { mode: "cdp", cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc", startedAt: now() };
    });
    // A bare connect means "use the default spawned transport" — it must drop
    // the cdp record (and write a disconnect audit row) rather than leave tools
    // silently driving the user's external Chrome.
    const status = await connectBrowser(config, {});
    expect(status.connected).toBe(false);
    expect(readState(config.instance).browser ?? null).toBeNull();
    const rows = readState(config.instance).audit.filter((r) => r.action === "browser.disconnect");
    expect(rows.length).toBe(1);
  });

  test("bare connect with no existing record is a pure no-op (no audit row)", async () => {
    const config = testConfig("cdp-bare-connect-noop");
    const status = await connectBrowser(config, {});
    expect(status.connected).toBe(false);
    expect(readState(config.instance).browser ?? null).toBeNull();
    expect(readState(config.instance).audit.filter((r) => r.action === "browser.disconnect").length).toBe(0);
  });

  test("connect re-attaches when the existing record's endpoint is no longer reachable", async () => {
    const config = testConfig("cdp-reconnect-stale");
    const { mutateState, now } = await import("../state");
    await mutateState(config.instance, (state) => {
      state.browser = { mode: "cdp", cdpUrl: "ws://127.0.0.1:9222/devtools/browser/old", startedAt: now() };
    });
    const originalFetch = globalThis.fetch;
    // The liveness re-probe of the existing record runs first with a SHORT
    // deadline (probeIntervalMs * 2 → at most two polls); fail those polls
    // deterministically by call count so the liveness probe returns null and we
    // fall through to a fresh attach (which the later call succeeds). Counting
    // calls (not wall-clock) is robust to event-loop stalls.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      // Cover the liveness window (deadline = 2*interval, so ≤ 2 attempts):
      // fail the first three calls outright, then succeed for the fresh attach.
      if (calls <= 3) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fresh" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    try {
      const status = await connectBrowser(
        config,
        { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/anything" },
        { probeIntervalMs: 10, probeTimeoutMs: 2000 }
      );
      expect(status.connected).toBe(true);
      expect(status.record?.cdpUrl).toBe("ws://127.0.0.1:9222/devtools/browser/fresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("connect attaches to a reachable CDP endpoint, persisting a stripped cdp record + audit", async () => {
    const config = testConfig("cdp-attach-ok");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/real", Browser: "Chrome/142" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as unknown as typeof fetch;
    try {
      const status = await connectBrowser(config, { cdpUrl: "ws://alice:pw@127.0.0.1:9222/devtools/browser/abc" });
      expect(status.connected).toBe(true);
      expect(status.record?.mode).toBe("cdp");
      // The persisted record strips embedded credentials.
      expect(status.record?.cdpUrl.includes("alice")).toBe(false);
      const persisted = readState(config.instance).browser;
      expect(persisted?.mode).toBe("cdp");
      const rows = readState(config.instance).audit.filter((r) => r.action === "browser.connect");
      expect(rows.length).toBe(1);
      expect(rows[0]!.evidence).toMatchObject({ mode: "cdp" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a cdp attach drops the cached spawned handle so the next tool call re-attaches", async () => {
    // Regression (live-caught): without dropping the cached in-process handle,
    // ensureShared short-circuits on the live spawned Chrome and never re-reads
    // the freshly-persisted cdp record, so the agent keeps driving the spawned
    // browser. connectBrowser must call disconnectSharedBrowser after the attach.
    const config = testConfig("cdp-drops-cached-handle");
    const browserMod = await import("../tools/browser");
    browserMod.setBrowserInstance(config.instance);
    let spawnedClosed = false;
    browserMod.__test.installFakeSpawnedHandleForTest(9333, {
      close: async () => {
        spawnedClosed = true;
      },
      pages: () => [],
      browser: () => ({ isConnected: () => true })
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/real" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as unknown as typeof fetch;
    try {
      const status = await connectBrowser(config, { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc" });
      expect(status.connected).toBe(true);
      // The cached spawned handle was torn down (its context.close() ran) and
      // the shared slot is now empty, so the next ensureShared rebuilds via cdp.
      expect(spawnedClosed).toBe(true);
      expect(browserMod.__test.uninstallFakeBrowserForTest().kind).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      browserMod.__test.uninstallFakeBrowserForTest();
      browserMod.__test.resetBrowserInstanceForTest();
    }
  });

  test("connect surfaces an unreachable CDP endpoint as a clear error (no record written)", async () => {
    const config = testConfig("cdp-attach-unreachable");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    try {
      await expect(
        // Shrink the probe deadline via the in-process internal arg so the
        // unreachable path returns fast instead of burning the 15s budget.
        connectBrowser(config, { cdpUrl: "ws://127.0.0.1:9999/devtools/browser/x" }, { probeTimeoutMs: 30, probeIntervalMs: 10 })
      ).rejects.toThrow(/Could not reach CDP endpoint/);
      expect(readState(config.instance).browser ?? null).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("connect treats a malformed existing record as a non-match and re-attaches", async () => {
    const config = testConfig("cdp-existing-malformed");
    const { mutateState } = await import("../state");
    // A hand-edited/corrupt record whose cdpUrl can't be URL-parsed: the
    // host-match comparison throws and is treated as 'not the same endpoint',
    // so we fall through to a fresh attach rather than reusing garbage.
    await mutateState(config.instance, (state) => {
      (state as unknown as Record<string, unknown>).browser = { mode: "cdp", cdpUrl: "::: not a url :::", startedAt: "2026-01-01T00:00:00.000Z" };
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/fresh" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as unknown as typeof fetch;
    try {
      const status = await connectBrowser(config, { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc" });
      expect(status.connected).toBe(true);
      expect(status.record?.cdpUrl).toBe("ws://127.0.0.1:9222/devtools/browser/fresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("connect rejects a loopback-but-malformed protocol before probing", async () => {
    const config = testConfig("cdp-attach-bad-proto");
    await expect(connectBrowser(config, { cdpUrl: "file:///etc/passwd" })).rejects.toThrow(
      /Unsupported cdpUrl protocol/
    );
    expect(readState(config.instance).browser ?? null).toBeNull();
  });

  test("status reports connected with the record once a cdp attach is persisted", async () => {
    const config = testConfig("cdp-status");
    const { mutateState, now } = await import("../state");
    await mutateState(config.instance, (state) => {
      state.browser = { mode: "cdp", cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc", startedAt: now() };
    });
    const status = getBrowserConnection(config);
    expect(status.connected).toBe(true);
    expect(status.record?.cdpUrl).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
  });

  test("disconnect clears a cdp record, writes a disconnect audit row, and detaches", async () => {
    const config = testConfig("cdp-disconnect");
    const { mutateState, now } = await import("../state");
    await mutateState(config.instance, (state) => {
      state.browser = { mode: "cdp", cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc", startedAt: now() };
    });
    const status = await disconnectBrowser(config);
    expect(status.connected).toBe(false);
    expect(readState(config.instance).browser ?? null).toBeNull();
    const rows = readState(config.instance).audit.filter((r) => r.action === "browser.disconnect");
    expect(rows.length).toBe(1);
    expect(rows[0]!.evidence).toMatchObject({ mode: "cdp" });
  });
});

// completeBrowserConnectSetup runs the non-screencast `/complete` fallback.
// Sign-in normally happens in-place via the screencast bridge (handled in the
// HTTP route), so this records that the user finished acting in the agent's
// spawned Chrome and writes the rich browser.connect audit row.
describe("completeBrowserConnectSetup", () => {
  test("returns success and writes a single rich browser.connect audit row", async () => {
    const config = testConfig("complete-setup");
    const { result, ok } = await completeBrowserConnectSetup(config, {
      id: "setup-1",
      target: "fallback target",
      taskId: undefined,
      agentId: undefined,
      payload: { reason: "Sign in to the store" }
    });
    expect(ok).toBe(true);
    const parsed = JSON.parse(result) as { success: boolean; connected: boolean; mode?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.connected).toBe(true);
    expect(parsed.mode).toBe("spawned");

    const rows = readState(config.instance).audit.filter((row) => row.action === "browser.connect");
    expect(rows.length).toBe(1);
    // The rich row carries the user-facing reason and the originating setup id.
    expect(rows[0]!.target).toBe("Sign in to the store");
    expect(rows[0]!.approvalId).toBe("setup-1");
    expect(rows[0]!.evidence).toMatchObject({ success: true, mode: "spawned" });
  });

  test("falls back to setup.target when no reason is supplied, and binds task scope", async () => {
    const config = testConfig("complete-setup-no-reason");
    const { mutateState } = await import("../state");
    const { createTask, upsertTask } = await import("../state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "complete", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    const { ok } = await completeBrowserConnectSetup(config, {
      id: "setup-2",
      target: "the literal target",
      taskId,
      agentId: undefined,
      payload: {}
    });
    expect(ok).toBe(true);
    const rows = readState(config.instance).audit.filter((row) => row.action === "browser.connect");
    expect(rows.length).toBe(1);
    expect(rows[0]!.target).toBe("the literal target");
    expect(rows[0]!.taskId).toBe(taskId);
  });

  test("binds agent scope when only an agentId is present", async () => {
    const config = testConfig("complete-setup-agent");
    const { ok } = await completeBrowserConnectSetup(config, {
      id: "setup-3",
      target: "agent target",
      taskId: undefined,
      agentId: "agent-xyz",
      payload: { reason: "Agent sign-in" }
    });
    expect(ok).toBe(true);
    const rows = readState(config.instance).audit.filter((row) => row.action === "browser.connect");
    expect(rows.length).toBe(1);
    expect(rows[0]!.agentId).toBe("agent-xyz");
  });
});
