import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  __test as browserTest,
  browserNavigate,
  closeAll,
  disconnectSharedBrowser,
  safetyCheck,
  setBrowserInstance,
  withTeardownLock
} from "./browser";
import { mutateState, readState } from "../state";

// Direct unit coverage for the URL safety guard. We exercise the function
// without spinning up Chromium since the guard runs synchronously on the
// raw URL string before any browser work begins.
describe("browser safetyCheck", () => {
  test("blocks IPv4-mapped IPv6 dotted-quad form pointing at metadata", () => {
    const result = safetyCheck("http://[::ffff:169.254.169.254]/");
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
  });

  test("blocks IPv4-mapped IPv6 canonical hex form pointing at metadata", () => {
    // Bun normalizes [::ffff:169.254.169.254] to [::ffff:a9fe:a9fe], so the
    // hex-form decoder is what actually catches the request in practice.
    const result = safetyCheck("http://[::ffff:a9fe:a9fe]/");
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
  });

  test("blocks fe80:: link-local IPv6", () => {
    const result = safetyCheck("http://[fe80::1]/");
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
  });

  test("does not false-positive on fe8:: (outside fe80::/10 range)", () => {
    // fe8::1 zero-expands to 0fe8:: which is not in the link-local range.
    // The previous regex `^fe[89ab][0-9a-f]?:` would over-match; the fix
    // requires the fourth hex digit so this no longer triggers.
    const result = safetyCheck("http://[fe8::1]/");
    expect(result).toBeUndefined();
  });

  test("does not leak secret-bearing input through Invalid URL error", () => {
    // Malformed URL that nonetheless contains an apparent token. The
    // pre-parse secret scan should catch it and return a generic
    // "Blocked:" message that does NOT echo the raw input.
    const sneaky = "not-a-url sk-ant-api03-DEADBEEFDEADBEEFDEADBEEFDEADBEEF";
    const result = safetyCheck(sneaky);
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
    expect(result).not.toContain("sk-ant-");
    expect(result).not.toContain(sneaky);
  });

  test("catches percent-encoded tokens hidden alongside malformed escapes", () => {
    // %zz is a malformed escape that would make all-or-nothing
    // decodeURIComponent throw, falling back to scanning only the raw form.
    // The percent-decoded `%73%6b-ant-api03-...` segment is `sk-ant-api03-...`
    // which should be detected by the permissive per-`%HH` decoder.
    const sneaky = "http://example.com/%zz/%73%6b-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const result = safetyCheck(sneaky);
    expect(result).toBeDefined();
    expect(result!.startsWith("Blocked:")).toBe(true);
    expect(result).not.toContain(sneaky);
    expect(result).not.toContain("sk-ant-");
    expect(result).not.toContain("%73%6b");
  });

  test("allows ordinary https URLs", () => {
    expect(safetyCheck("https://example.com/")).toBeUndefined();
  });
});

// Smoke test for the CDP-vs-launch decision. We can't actually exercise
// playwright-core's connectOverCDP / launch without spawning Chromium —
// the real verification happens in the manual end-to-end run. What we CAN
// verify here is that the session manager reads state.browser through the
// instance registered via setBrowserInstance(), so the wiring between the
// browser-connect capability and the tool layer is consistent.
describe("browser session manager state lookup", () => {
  const TEST_ROOT = "/tmp/gini-browser-state-tests";
  process.env["GINI_STATE_ROOT"] = TEST_ROOT;
  const instance = `browser-state-${process.pid}`;

  afterAll(() => {
    // Reset the module-level instance pointer so subsequent test files
    // in the same run don't accidentally read this test instance's state.
    // Passing the literal "dev" matches the production default.
    setBrowserInstance("dev");
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  test("setBrowserInstance points readState at the right instance", async () => {
    rmSync(`${TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
    // Seed a connection record so the session manager would, on next
    // browser tool call, attempt connectOverCDP() instead of launch().
    // We don't actually trigger that branch (no real CDP endpoint) but
    // the state shape it consumes is what we verify.
    await mutateState(instance, (state) => {
      state.browser = {
        mode: "cdp",
        cdpUrl: "ws://127.0.0.1:65535/devtools/browser/test",
        pid: null,
        dataDir: null,
        chromePath: null,
        startedAt: new Date().toISOString()
      };
    });
    setBrowserInstance(instance);
    const state = readState(instance);
    expect(state.browser?.cdpUrl).toContain("127.0.0.1:65535");
  });
});

// Persistent-profile pivot: SharedHandle collapsed to { persistent | cdp }.
// "headless" no longer exists as a separate variant — both the default
// headless agent path and the visible Connect window share one persistent
// BrowserContext arm; only the `headed` flag at launch differs.
describe("browser disconnect lifecycle", () => {
  afterEach(() => {
    // Clean up any synthetic state the previous test installed so
    // subsequent tests start from zero.
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.clearPendingSharedForTest();
  });

  test("in-flight disconnect rejects new browser_navigate admissions", async () => {
    browserTest.setInFlightDisconnectsForTest(1);
    const result = await browserNavigate("disconnect-test-task", { url: "https://example.com/" });
    const parsed = JSON.parse(result) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/disconnecting/i);
  });

  test("disconnectSharedBrowser does not call close() on a CDP browser missing disconnect()", async () => {
    let closeCalled = false;
    browserTest.installFakeCdpBrowserForTest({
      // Intentionally no disconnect() — exactly the playwright-core
      // shape that previously triggered the buggy fallback. close()
      // over CDP terminates the user's Chrome, which we must avoid.
      close: async () => {
        closeCalled = true;
      }
    });
    await disconnectSharedBrowser();
    expect(closeCalled).toBe(false);
  });

  test("disconnectSharedBrowser calls disconnect() when available on CDP browser", async () => {
    let disconnectCalled = false;
    let closeCalled = false;
    browserTest.installFakeCdpBrowserForTest({
      disconnect: async () => {
        disconnectCalled = true;
      },
      close: async () => {
        closeCalled = true;
      }
    });
    await disconnectSharedBrowser();
    expect(disconnectCalled).toBe(true);
    expect(closeCalled).toBe(false);
  });

  test("disconnectSharedBrowser closes the visible persistent context (terminating Chromium)", async () => {
    // Visibility-toggle disconnect path: closing the BrowserContext is how
    // we shut down the Chromium process Playwright launched. The same arm
    // handles the next-call relaunch with `headless: true` against the
    // same profile dir, so sign-ins persist.
    let contextCloseCalled = false;
    browserTest.installFakeManagedContextForTest({
      close: async () => {
        contextCloseCalled = true;
      }
    });
    await disconnectSharedBrowser();
    expect(contextCloseCalled).toBe(true);
  });

  test("disconnectSharedBrowser also closes the HEADLESS persistent context", async () => {
    // Same teardown arm regardless of headed flag — when the user calls
    // wipe-profile, the headless persistent context must come down too so
    // the rm -rf isn't fighting an open Chromium handle. Tests the
    // headed=false variant explicitly so we don't regress that branch.
    let contextCloseCalled = false;
    browserTest.installFakeHeadlessPersistentContextForTest({
      close: async () => {
        contextCloseCalled = true;
      }
    });
    await disconnectSharedBrowser();
    expect(contextCloseCalled).toBe(true);
  });

  test("closeAll skips close() on a CDP browser missing disconnect()", async () => {
    let closeCalled = false;
    browserTest.installFakeCdpBrowserForTest({
      close: async () => {
        closeCalled = true;
      }
    });
    await closeAll();
    expect(closeCalled).toBe(false);
  });

  test("disconnectSharedBrowser drains in-flight before tearing down", async () => {
    let closeCalled = false;
    browserTest.installFakeManagedContextForTest({
      close: async () => {
        closeCalled = true;
      }
    });
    // Install a synthetic session reporting an in-flight call.
    browserTest.installFakeSessionForTest("drain-task", 1);
    // Schedule the in-flight to drop to zero after a short delay, well
    // under the 5s deadline. disconnect should observe the drop and
    // proceed.
    setTimeout(() => {
      browserTest.setFakeSessionInFlight("drain-task", 0);
    }, 150);
    const started = Date.now();
    await disconnectSharedBrowser();
    const elapsed = Date.now() - started;
    expect(closeCalled).toBe(true);
    // The wait loop sleeps in 50ms increments, so we should have slept
    // at least ~100ms but well under the 5s deadline.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(2_000);
  });

  // Round-3 review fix: epoch counter. withSession captures the current
  // disconnect generation before awaiting getOrCreate; after the await
  // resumes it compares the current generation to the captured one and
  // bails out cleanly if a disconnect ran (or completed) in the gap.
  // This is deterministic — we control the pendingBrowser promise so
  // getOrCreate's await suspends until we resolve it AFTER bumping the
  // generation.
  test("withSession bails when disconnect generation advances during admission", async () => {
    // Install a pendingShared that we control so ensureShared's await
    // suspends at our latch instead of hitting playwright-core's real
    // launch (which would fail with "Chromium not found" and obscure
    // the assertion). The fake persistent handle is what getOrCreate
    // would see after the await resolves — but the test bumps the
    // generation BEFORE we resolve, so the post-await re-check bails
    // before getOrCreate ever touches it.
    let resolveShared: (handle: unknown) => void = () => undefined;
    const fakeContext = {
      pages: () => [],
      newPage: async () => ({
        on: () => undefined,
        close: () => Promise.resolve(),
        goto: () => Promise.resolve(null),
        url: () => "about:blank",
        title: () => Promise.resolve(""),
        evaluate: () => Promise.resolve([])
      }),
      close: () => Promise.resolve()
    };
    const fakeHandle = {
      kind: "persistent" as const,
      context: fakeContext,
      headed: false
    };
    const pending = new Promise<unknown>((resolve) => {
      resolveShared = resolve;
    });
    browserTest.installPendingSharedForTest(pending as Promise<never>);

    // Kick off the navigation. withSession captures the generation,
    // bumps pendingAdmissions, awaits getOrCreate -> ensureShared ->
    // pendingShared, and suspends.
    const navigatePromise = browserNavigate("admission-race", { url: "https://example.com/" });

    // Yield a microtask so withSession has actually entered the await
    // chain before we bump the generation.
    await new Promise((resolve) => setImmediate(resolve));

    // Simulate a disconnect completing while our admission was
    // suspended. Bump the generation; this is exactly what the real
    // disconnectSharedBrowser does at its top.
    browserTest.bumpDisconnectGenerationForTest();

    // Now resolve the pendingShared so the suspended admission resumes
    // and runs the post-await re-check. It should observe the
    // generation mismatch and bail.
    resolveShared(fakeHandle);

    const result = await navigatePromise;
    const parsed = JSON.parse(result) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/disconnecting/i);
  });
});

describe("chromeProfileDirFor", () => {
  test("derives the per-instance profile path from instance name", async () => {
    const { chromeProfileDirFor } = await import("./browser");
    const dir = chromeProfileDirFor("dev");
    expect(dir.endsWith("chrome-profile")).toBe(true);
    expect(dir.includes("dev")).toBe(true);
  });
});

// Round-1 fix: withTeardownLock holds the admission gate closed across
// the disconnect-then-launch (Connect) and disconnect-then-rm (Wipe)
// critical sections. Without it, an admission landing between the two
// awaits could re-acquire the profile lock with a fresh headless
// persistent context and fight the caller for the dir.
describe("withTeardownLock", () => {
  afterEach(() => {
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.clearPendingSharedForTest();
  });

  test("rejects parallel withSession admissions while the lock is held", async () => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockPromise = withTeardownLock(async () => {
      await released;
    });
    // Yield so withTeardownLock has actually entered (incremented the
    // generation + inFlightDisconnects) before we attempt the admission.
    await new Promise((resolve) => setImmediate(resolve));
    const result = await browserNavigate("teardown-lock-task", { url: "https://example.com/" });
    const parsed = JSON.parse(result) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/disconnecting/i);
    release();
    await lockPromise;
  });

  test("restores the gate when fn throws so future admissions can land", async () => {
    await expect(
      withTeardownLock(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow(/boom/);
    expect(browserTest.inFlightDisconnectsForTest()).toBe(0);
  });
});

// Round-1 fix: disconnectSharedBrowser must await any in-flight launch
// (pendingShared) before tearing down. A slow launchPersistentContext
// started just before disconnect can otherwise complete after the drain
// and install itself into `shared`, holding the profile lock against
// the Connect/Wipe that's running this teardown.
describe("disconnectSharedBrowser pending-launch handling", () => {
  afterEach(() => {
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.clearPendingSharedForTest();
  });

  test("waits for an in-flight pendingShared launch and clears the resulting handle", async () => {
    // Build a pendingShared that resolves to a fake persistent context
    // AFTER disconnect has bumped the generation but before disconnect
    // has finished its drain. The natural ensureShared post-await
    // re-check would normally throw and tear down the freshly-built
    // handle, but we install pendingShared directly without going
    // through ensureShared so that re-check never runs. The disconnect
    // path itself must observe the leftover `shared` and tear it down.
    let contextCloseCalled = false;
    const fakeContext = {
      pages: () => [],
      close: async () => {
        contextCloseCalled = true;
      }
    };
    let resolvePending: (handle: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      resolvePending = resolve;
    });
    browserTest.installPendingSharedForTest(pending as Promise<never>);

    // Kick off disconnect. It bumps the generation, increments
    // inFlightDisconnects, then enters the drain loop. pendingAdmissions
    // is 0, so the drain loop exits immediately. Then it should await
    // pendingShared and observe whatever the launch installs.
    const disconnectPromise = disconnectSharedBrowser();

    // Give disconnect a tick to enter the drain loop and reach the
    // pendingShared await.
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Simulate a slow launch finishing AND installing itself into
    // shared. We have to do the install ourselves because the test
    // bypassed ensureShared's installer.
    browserTest.installFakeHeadlessPersistentContextForTest(fakeContext);
    resolvePending(fakeContext);

    await disconnectPromise;
    // The disconnect path must have observed the freshly-installed
    // shared handle and torn it down (closing the context).
    expect(contextCloseCalled).toBe(true);
  });
});

// Round-1 fix 5: realistic coverage that the no-record default tool
// path launches launchPersistentContext against the per-instance profile
// dir with headless: true. Mocks playwright-core at the module level so
// ensureShared exercises its persistent arm without spawning Chrome.
describe("ensureShared default headless persistent launch", () => {
  afterEach(() => {
    browserTest.uninstallFakeBrowserForTest();
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    browserTest.clearPendingSharedForTest();
  });

  test("launches launchPersistentContext(profileDir, { headless: true }) when no state.browser exists", async () => {
    const TEST_ROOT = "/tmp/gini-browser-default-headless";
    process.env["GINI_STATE_ROOT"] = TEST_ROOT;
    const instance = `default-headless-${process.pid}`;
    rmSync(`${TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
    setBrowserInstance(instance);

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
            close: async () => undefined
          };
        }
      }
    }));
    browserTest.resetChromiumImportForTest();

    try {
      // Trigger the default tool path. We don't care about navigation
      // semantics here — the snapshot may fail since our fake page
      // isn't a real Playwright Page — but launchPersistentContext should
      // have been invoked exactly once with the per-instance profile dir
      // and headless: true before any of that.
      await browserNavigate("default-headless-task", { url: "https://example.com/" });
    } catch {
      // Snapshot wiring may throw; the assertion below is what matters.
    } finally {
      mock.restore();
      browserTest.uninstallFakeBrowserForTest();
      browserTest.clearFakeSessionsForTest();
      browserTest.resetChromiumImportForTest();
      setBrowserInstance("dev");
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }

    expect(launchCalls.length).toBe(1);
    const call = launchCalls[0]!;
    expect(call.options.headless).toBe(true);
    expect(call.dataDir).toContain("chrome-profile");
    expect(call.dataDir).toContain(instance);
  });
});
