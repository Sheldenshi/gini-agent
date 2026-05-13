import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  __test as browserTest,
  browserDrag,
  browserHover,
  browserNavigate,
  browserSelectOption,
  browserTabs,
  browserUploadFile,
  browserVision,
  browserWaitFor,
  closeAll,
  currentDisconnectGeneration,
  disconnectSharedBrowser,
  safetyCheck,
  setBrowserInstance,
  withTeardownLock
} from "./browser";
import { dispatchToolCall } from "../execution/tool-dispatch";
import { clearEchoVisionResponses, setEchoVisionResponse } from "../provider";
import { createTask, mutateState, readState, upsertTask } from "../state";
import type { RuntimeConfig } from "../types";

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

// Walker behavior: <select> options should land in the snapshot as sibling
// rows immediately after the select itself, each with its own @eN ref and a
// value="..." annotation. We sidestep Chromium by mocking the page.evaluate
// surface — it just runs the walker's function literal locally against a
// hand-built fake document. The walker only relies on a small slice of DOM
// APIs (tagName, attributes, children, computed style, bounding rect), so
// the stubs stay compact.
describe("snapshot walker — <select> option surfacing", () => {
  test("emits <option> children as @eN-refed siblings after the select", async () => {
    type FakeEl = {
      tagName: string;
      type?: string;
      value?: string;
      disabled?: boolean;
      hidden?: boolean;
      label?: string;
      text?: string;
      _attrs: Record<string, string>;
      _children: FakeEl[];
      _textContent: string;
      getAttribute(name: string): string | null;
      setAttribute(name: string, value: string): void;
      removeAttribute(name: string): void;
      getBoundingClientRect(): { width: number; height: number };
      get children(): FakeEl[];
      get textContent(): string;
      querySelectorAll(selector: string): FakeEl[];
    };
    const makeEl = (init: Partial<FakeEl> & { tagName: string; visible?: boolean; children?: FakeEl[]; textContent?: string }): FakeEl => {
      const visible = init.visible ?? true;
      const children = init.children ?? [];
      const el: FakeEl = {
        tagName: init.tagName,
        type: init.type,
        value: init.value,
        disabled: init.disabled,
        hidden: init.hidden,
        label: init.label,
        text: init.text,
        _attrs: { ...(init as { _attrs?: Record<string, string> })._attrs },
        _children: children,
        _textContent: init.textContent ?? "",
        getAttribute(name: string) {
          return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name]! : null;
        },
        setAttribute(name: string, value: string) {
          this._attrs[name] = value;
        },
        removeAttribute(name: string) {
          delete this._attrs[name];
        },
        getBoundingClientRect() {
          return visible ? { width: 100, height: 20 } : { width: 0, height: 0 };
        },
        get children() {
          return this._children;
        },
        get textContent() {
          return this._textContent;
        },
        querySelectorAll(selector: string) {
          // Only used by the walker for `option` (and the cleanup
          // `[data-gini-ref]` selector at the top of snapshot()).
          const matches: FakeEl[] = [];
          const recurse = (node: FakeEl) => {
            if (selector === "option") {
              if (node.tagName === "OPTION") matches.push(node);
            } else if (selector.startsWith("[") && selector.endsWith("]")) {
              const attr = selector.slice(1, -1);
              if (Object.prototype.hasOwnProperty.call(node._attrs, attr)) matches.push(node);
            }
            for (const child of node._children) recurse(child);
          };
          for (const child of this._children) recurse(child);
          return matches;
        }
      };
      return el;
    };

    // <body>
    //   <select name="size">
    //     <option value="s">Small</option>
    //     <option value="m">Medium</option>
    //     <option value="l" disabled>Large</option>
    //   </select>
    // </body>
    const optS = makeEl({ tagName: "OPTION", value: "s", text: "Small", label: "Small", textContent: "Small" });
    const optM = makeEl({ tagName: "OPTION", value: "m", text: "Medium", label: "Medium", textContent: "Medium" });
    const optL = makeEl({ tagName: "OPTION", value: "l", text: "Large", label: "Large", disabled: true, textContent: "Large" });
    const select = makeEl({
      tagName: "SELECT",
      value: "s",
      children: [optS, optM, optL],
      textContent: "Small Medium Large"
    });
    const body = makeEl({ tagName: "BODY", children: [select] });

    const docQueryAll = (selector: string): FakeEl[] => body.querySelectorAll(selector);
    const originalDocument = (globalThis as Record<string, unknown>).document;
    const originalWindow = (globalThis as Record<string, unknown>).window;
    const originalCSS = (globalThis as Record<string, unknown>).CSS;
    (globalThis as unknown as { document: unknown }).document = {
      body,
      querySelectorAll: docQueryAll,
      querySelector: (_sel: string) => null,
      getElementById: (_id: string) => null
    };
    (globalThis as unknown as { window: unknown }).window = {
      getComputedStyle: (_el: unknown) => ({ display: "block", visibility: "visible" })
    };
    (globalThis as unknown as { CSS: unknown }).CSS = { escape: (s: string) => s };

    // Fake Page whose page.evaluate(fn, arg) simply runs fn(arg) locally.
    let pageCallCount = 0;
    const fakePage = {
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => {
        pageCallCount++;
        return Promise.resolve(fn(arg as A));
      },
      locator: (_sel: string) => ({} as unknown)
    } as unknown as import("playwright-core").Page;

    try {
      const result = await browserTest.snapshotForTest(fakePage, false);
      expect(pageCallCount).toBeGreaterThanOrEqual(1);
      // The select itself must be present as a combobox.
      expect(result.text).toContain("combobox");
      // The two enabled options should each show as an `option "<name>"
      // value="<v>"` row.
      const optionLines = result.text.split("\n").filter((line) => line.includes(" option "));
      expect(optionLines.length).toBeGreaterThanOrEqual(2);
      expect(result.text).toContain('option "Small" value="s"');
      expect(result.text).toContain('option "Medium" value="m"');
      // Disabled option is filtered.
      expect(result.text).not.toContain('value="l"');
      // Distinct refs per option (we just check that each option line
      // carries its own [@eN] token and they're not the same).
      const refs = optionLines
        .map((line) => /\[(@e\d+)\]/.exec(line)?.[1])
        .filter((r): r is string => Boolean(r));
      expect(refs.length).toBeGreaterThanOrEqual(2);
      expect(new Set(refs).size).toBe(refs.length);
    } finally {
      if (originalDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = originalDocument;
      }
      if (originalWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = originalWindow;
      }
      if (originalCSS === undefined) {
        delete (globalThis as Record<string, unknown>).CSS;
      } else {
        (globalThis as Record<string, unknown>).CSS = originalCSS;
      }
    }
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

// browser_vision: screenshots the current page and asks the configured vision
// model a question. We install a fake session with a stub `page.screenshot`
// so we don't need a real Chromium, and route the provider through the echo
// stub so the model response is deterministic.
describe("browserVision", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    clearEchoVisionResponses();
  });

  test("screenshots the current page and threads the question through generateVisionAnalysis", async () => {
    let screenshotCalls = 0;
    const fakePage = {
      screenshot: async (_opts: { type: "png"; fullPage?: boolean }) => {
        screenshotCalls++;
        // Tiny PNG header bytes — any non-empty Buffer is sufficient since
        // the provider call is stubbed.
        return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      },
      url: () => "https://example.com/dashboard"
    };
    browserTest.installFakeSessionWithPageForTest("vision-task", fakePage);

    setEchoVisionResponse({ text: "There is a login form in the center of the page." });

    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-task", { question: "What is on this page?" }, config);
    const parsed = JSON.parse(raw) as {
      success: boolean;
      answer?: string;
      bytes?: number;
      url?: string;
      full?: boolean;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.answer).toContain("login form");
    expect(parsed.bytes).toBeGreaterThan(0);
    expect(parsed.url).toBe("https://example.com/dashboard");
    expect(parsed.full).toBe(false);
    expect(screenshotCalls).toBe(1);
  });

  test("fails fast when the screenshot exceeds the 5MB byte cap", async () => {
    // Hand the fake page a >5MB Buffer. We allocate exactly 5MB + 1
    // byte to avoid wasting test memory while still tripping the cap.
    const oversize = Buffer.alloc(5 * 1024 * 1024 + 1, 0xff);
    const fakePage = {
      screenshot: async () => oversize,
      url: () => "https://example.com/big"
    };
    browserTest.installFakeSessionWithPageForTest("vision-oversize", fakePage);
    setEchoVisionResponse({ text: "should-not-be-reached" });

    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-oversize", { question: "describe" }, config);
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/Screenshot too large/);
    expect(parsed.error).toMatch(/5MB cap/);
  });

  test("bails with 'Browser disconnecting' if the generation advances between baseline and provider return", async () => {
    // browserVision captures the disconnect generation BEFORE the
    // screenshot await, then re-checks AFTER the provider response. To
    // exercise that re-check we bump the generation from inside the fake
    // screenshot itself, AFTER browserVision has captured its baseline —
    // i.e. while browserVision is suspended on the screenshot await. By
    // the time the provider call finishes and the re-check fires, the
    // generation has moved past the baseline and browserVision returns
    // the standard "Browser disconnecting" sentinel.
    const fakePage = {
      screenshot: async () => {
        // Bump while suspended inside the screenshot await — this is the
        // window the re-check is designed to catch.
        browserTest.bumpDisconnectGenerationForTest();
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      },
      url: () => "https://example.com/disconnect"
    };
    browserTest.installFakeSessionWithPageForTest("vision-disconnect", fakePage);
    setEchoVisionResponse({ text: "fake-answer" });
    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-disconnect", { question: "what" }, config);
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/disconnecting/i);
  });

  test("envelope carries provider cost so the dispatcher can accumulate it into task.cost", async () => {
    const fakePage = {
      screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      url: () => "https://example.com/dashboard"
    };
    browserTest.installFakeSessionWithPageForTest("vision-cost", fakePage);
    // Provide a stubbed response with a fake cost record so the
    // browserVision envelope picks it up.
    setEchoVisionResponse({
      text: "answer with cost",
      cost: {
        provider: "echo",
        model: "gini-echo-v0",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        estimatedUsd: 0.00012
      }
    });
    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-cost", { question: "what?" }, config);
    const parsed = JSON.parse(raw) as { success: boolean; cost?: { totalTokens?: number } };
    expect(parsed.success).toBe(true);
    expect(parsed.cost?.totalTokens).toBe(120);
  });

  test("rejects calls missing the required question argument", async () => {
    const fakePage = {
      screenshot: async () => Buffer.from([0x89]),
      url: () => "https://example.com/"
    };
    browserTest.installFakeSessionWithPageForTest("vision-missing-q", fakePage);
    const config: RuntimeConfig = {
      instance: "test",
      port: 7337,
      token: "test",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: "/tmp/gini-vision-test",
      logRoot: "/tmp/gini-vision-test-logs"
    };
    const raw = await browserVision("vision-missing-q", {}, config);
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/question/i);
  });
});

// Shared helper: build a minimal fake Page that satisfies the surface our
// tool entry points exercise (evaluate for snapshot, title/url, optional
// waitForLoadState). Tests planted refs directly via setFakeSessionRefsForTest
// so the walker doesn't need to run — they pass `fullMode: false` and we
// return an empty raw array which yields an empty snapshot.
function makeFakePageForRefTools(url = "https://example.com/"): Partial<import("playwright-core").Page> {
  return {
    url: () => url,
    title: () => Promise.resolve("Example"),
    // Walker invokes page.evaluate twice (clear stale refs, then walk). We
    // resolve to undefined for the cleanup pass and an empty array for the
    // walk so the snapshot text is just empty.
    evaluate: (async () => []) as unknown as import("playwright-core").Page["evaluate"],
    waitForLoadState: (async () => undefined) as unknown as import("playwright-core").Page["waitForLoadState"]
  };
}

describe("browserHover", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("resolves the ref and calls locator.hover with a 10s timeout", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("hover-task", fakePage);
    const hoverCalls: Array<{ timeout?: number }> = [];
    const fakeLocator = {
      hover: async (opts?: { timeout?: number }) => {
        hoverCalls.push(opts ?? {});
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e3", fakeLocator);
    browserTest.setFakeSessionRefsForTest("hover-task", refs);

    const raw = await browserHover("hover-task", { ref: "@e3" });
    const parsed = JSON.parse(raw) as { success: boolean; url?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.url).toBe("https://example.com/");
    expect(hoverCalls.length).toBe(1);
    expect(hoverCalls[0]!.timeout).toBe(10_000);
  });

  test("returns the standard 'Unknown ref' error for missing refs", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("hover-missing", fakePage);
    const raw = await browserHover("hover-missing", { ref: "@e99" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e99");
    expect(parsed.error).toContain("fresh snapshot");
  });

  test("rejects missing ref argument", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("hover-noarg", fakePage);
    const raw = await browserHover("hover-noarg", {});
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/ref/i);
  });
});

describe("browserDrag", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("calls dragTo(toLoc, { timeout: 10000 }) on the from-locator", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("drag-task", fakePage);
    const fromLoc = {
      dragTo: async (target: unknown, opts?: { timeout?: number }) => {
        (fromLoc as unknown as { _called: { target: unknown; opts?: { timeout?: number } } })._called = {
          target,
          opts: opts ?? {}
        };
      }
    };
    const toLoc = { _marker: "to" };
    const refs = new Map<string, unknown>();
    refs.set("@e1", fromLoc);
    refs.set("@e2", toLoc);
    browserTest.setFakeSessionRefsForTest("drag-task", refs);

    const raw = await browserDrag("drag-task", { fromRef: "@e1", toRef: "@e2" });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    const captured = (fromLoc as unknown as { _called?: { target: unknown; opts?: { timeout?: number } } })._called;
    expect(captured).toBeDefined();
    expect(captured!.target).toBe(toLoc);
    expect(captured!.opts!.timeout).toBe(10_000);
  });

  test("returns 'Unknown ref' when fromRef is missing", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("drag-bad-from", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e2", { dragTo: async () => undefined });
    browserTest.setFakeSessionRefsForTest("drag-bad-from", refs);

    const raw = await browserDrag("drag-bad-from", { fromRef: "@e1", toRef: "@e2" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e1");
  });

  test("returns 'Unknown ref' when toRef is missing", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("drag-bad-to", fakePage);
    const fromLoc = { dragTo: async () => undefined };
    const refs = new Map<string, unknown>();
    refs.set("@e1", fromLoc);
    browserTest.setFakeSessionRefsForTest("drag-bad-to", refs);

    const raw = await browserDrag("drag-bad-to", { fromRef: "@e1", toRef: "@e2" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e2");
  });

  test("rejects missing arguments", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("drag-noargs", fakePage);
    const rawMissingFrom = await browserDrag("drag-noargs", { toRef: "@e2" });
    expect(JSON.parse(rawMissingFrom).error).toMatch(/fromRef/);
    const rawMissingTo = await browserDrag("drag-noargs", { fromRef: "@e1" });
    expect(JSON.parse(rawMissingTo).error).toMatch(/toRef/);
  });
});

describe("browserSelectOption", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("forwards single value to locator.selectOption", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-single", fakePage);
    let captured: { selection: unknown; timeout?: number } | undefined;
    const loc = {
      selectOption: async (selection: unknown, opts?: { timeout?: number }) => {
        captured = { selection, timeout: opts?.timeout };
        return [];
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e3", loc);
    browserTest.setFakeSessionRefsForTest("sel-single", refs);

    const raw = await browserSelectOption("sel-single", { ref: "@e3", value: "medium" });
    const parsed = JSON.parse(raw) as { success: boolean; selected?: unknown };
    expect(parsed.success).toBe(true);
    expect(parsed.selected).toBe("medium");
    expect(captured).toBeDefined();
    expect(captured!.selection).toBe("medium");
    expect(captured!.timeout).toBe(10_000);
  });

  test("forwards values[] to locator.selectOption for multi-select", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-multi", fakePage);
    let captured: { selection: unknown } | undefined;
    const loc = {
      selectOption: async (selection: unknown) => {
        captured = { selection };
        return [];
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e3", loc);
    browserTest.setFakeSessionRefsForTest("sel-multi", refs);

    const raw = await browserSelectOption("sel-multi", { ref: "@e3", values: ["a", "b"] });
    const parsed = JSON.parse(raw) as { success: boolean; selected?: unknown };
    expect(parsed.success).toBe(true);
    expect(parsed.selected).toEqual(["a", "b"]);
    expect(captured!.selection).toEqual(["a", "b"]);
  });

  test("rejects when neither value nor values is supplied", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-neither", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e3", { selectOption: async () => [] });
    browserTest.setFakeSessionRefsForTest("sel-neither", refs);

    const raw = await browserSelectOption("sel-neither", { ref: "@e3" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/value/i);
  });

  test("rejects when both value and values are supplied", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-both", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e3", { selectOption: async () => [] });
    browserTest.setFakeSessionRefsForTest("sel-both", refs);

    const raw = await browserSelectOption("sel-both", { ref: "@e3", value: "a", values: ["b"] });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/either.*'value'.*or.*'values'/i);
  });

  test("rejects when values is not an array of strings", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-bad-values", fakePage);
    const refs = new Map<string, unknown>();
    refs.set("@e3", { selectOption: async () => [] });
    browserTest.setFakeSessionRefsForTest("sel-bad-values", refs);

    // Non-array
    const rawNotArray = await browserSelectOption("sel-bad-values", { ref: "@e3", values: "not-an-array" });
    expect(JSON.parse(rawNotArray).error).toMatch(/array of strings/i);

    // Array with a non-string element
    const rawMixed = await browserSelectOption("sel-bad-values", { ref: "@e3", values: ["a", 1] });
    expect(JSON.parse(rawMixed).error).toMatch(/array of strings/i);
  });

  test("returns 'Unknown ref' when the ref isn't in the latest snapshot", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-bad-ref", fakePage);
    const raw = await browserSelectOption("sel-bad-ref", { ref: "@e99", value: "x" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Unknown ref @e99");
  });

  test("rejects missing ref argument", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-no-ref", fakePage);
    const raw = await browserSelectOption("sel-no-ref", { value: "x" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/ref/);
  });
});

describe("browserWaitFor", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("ref-mode forwards { state, timeout } to locator.waitFor", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-ref", fakePage);
    let captured: { state?: string; timeout?: number } | undefined;
    const loc = {
      waitFor: async (opts: { state?: string; timeout?: number }) => {
        captured = { state: opts.state, timeout: opts.timeout };
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e3", loc);
    browserTest.setFakeSessionRefsForTest("wait-ref", refs);

    const raw = await browserWaitFor("wait-ref", { ref: "@e3", state: "hidden", timeoutMs: 2500 });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    expect(captured).toBeDefined();
    expect(captured!.state).toBe("hidden");
    expect(captured!.timeout).toBe(2500);
  });

  test("ref-mode defaults state to 'visible' and timeout to 10000", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-defaults", fakePage);
    let captured: { state?: string; timeout?: number } | undefined;
    const loc = {
      waitFor: async (opts: { state?: string; timeout?: number }) => {
        captured = { state: opts.state, timeout: opts.timeout };
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e1", loc);
    browserTest.setFakeSessionRefsForTest("wait-defaults", refs);

    await browserWaitFor("wait-defaults", { ref: "@e1" });
    expect(captured!.state).toBe("visible");
    expect(captured!.timeout).toBe(10_000);
  });

  test("text-mode calls page.waitForFunction with the needle and timeout", async () => {
    let captured: { needle?: string; timeout?: number } | undefined;
    const fakePage = {
      url: () => "https://example.com/",
      title: () => Promise.resolve("Example"),
      evaluate: (async () => []) as unknown as import("playwright-core").Page["evaluate"],
      waitForFunction: (async (
        _fn: unknown,
        arg: unknown,
        opts?: { timeout?: number }
      ): Promise<undefined> => {
        captured = { needle: typeof arg === "string" ? arg : undefined, timeout: opts?.timeout };
        return undefined;
      }) as unknown as import("playwright-core").Page["waitForFunction"]
    } as Partial<import("playwright-core").Page>;
    browserTest.installFakeSessionWithPageForTest("wait-text", fakePage);

    const raw = await browserWaitFor("wait-text", { text: "Logged in", timeoutMs: 5000 });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    expect(captured).toBeDefined();
    expect(captured!.needle).toBe("Logged in");
    expect(captured!.timeout).toBe(5000);
  });

  test("surfaces a structured 'Wait timed out' error when waitFor throws timeout", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-timeout", fakePage);
    const loc = {
      waitFor: async () => {
        throw new Error("locator.waitFor: Timeout 2000ms exceeded.");
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e1", loc);
    browserTest.setFakeSessionRefsForTest("wait-timeout", refs);

    const raw = await browserWaitFor("wait-timeout", { ref: "@e1", timeoutMs: 2000 });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/^Wait timed out after 2000ms/);
  });

  test("rejects when both ref and text are supplied", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-both", fakePage);
    const raw = await browserWaitFor("wait-both", { ref: "@e1", text: "Hello" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/either 'ref' or 'text'/);
  });

  test("rejects when neither ref nor text is supplied", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-neither", fakePage);
    const raw = await browserWaitFor("wait-neither", {});
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/either 'ref' or 'text'/);
  });

  test("rejects invalid state values", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-bad-state", fakePage);
    const raw = await browserWaitFor("wait-bad-state", { ref: "@e1", state: "bogus" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/state.*visible.*hidden.*attached.*detached/i);
  });

  test("rejects invalid timeoutMs", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-bad-timeout", fakePage);
    const rawZero = await browserWaitFor("wait-bad-timeout", { ref: "@e1", timeoutMs: 0 });
    expect(JSON.parse(rawZero).error).toMatch(/positive number/);
    const rawNeg = await browserWaitFor("wait-bad-timeout", { ref: "@e1", timeoutMs: -100 });
    expect(JSON.parse(rawNeg).error).toMatch(/positive number/);
    const rawStr = await browserWaitFor("wait-bad-timeout", { ref: "@e1", timeoutMs: "10s" });
    expect(JSON.parse(rawStr).error).toMatch(/positive number/);
  });

  test("returns Unknown ref when the ref isn't planted", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("wait-bad-ref", fakePage);
    const raw = await browserWaitFor("wait-bad-ref", { ref: "@e99" });
    expect(JSON.parse(raw).error).toContain("Unknown ref @e99");
  });
});

// Tabs tests need a fake context.pages() controllable from the test, plus a
// way to assert which page is currently active on the session after a swap.
// We use installFakeSessionWithPageAndContextForTest to plant both.
type FakeTabPage = Partial<import("playwright-core").Page> & {
  _label: string;
  _closed?: boolean;
};

function makeFakeTabPage(label: string, url: string): FakeTabPage {
  const page: FakeTabPage = {
    _label: label,
    url: () => url,
    title: () => Promise.resolve(`title:${label}`),
    evaluate: (async () => []) as unknown as import("playwright-core").Page["evaluate"],
    goto: (async () => null) as unknown as import("playwright-core").Page["goto"],
    bringToFront: (async () => undefined) as unknown as import("playwright-core").Page["bringToFront"],
    on: (() => undefined) as unknown as import("playwright-core").Page["on"],
    close: (async () => {
      page._closed = true;
    }) as unknown as import("playwright-core").Page["close"]
  };
  return page;
}

describe("browserTabs", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("list returns one entry per page with active flag", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const p1 = makeFakeTabPage("p1", "https://b.example/");
    const pages = [p0, p1];
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => pages) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => makeFakeTabPage("new", "about:blank")) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-list", p1, context);

    const raw = await browserTabs("tabs-list", { action: "list" });
    const parsed = JSON.parse(raw) as {
      success: boolean;
      url?: string;
      tabs?: Array<{ index: number; url: string; title: string; active: boolean }>;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.url).toBe("https://b.example/");
    expect(parsed.tabs).toBeDefined();
    expect(parsed.tabs!.length).toBe(2);
    expect(parsed.tabs![0]!.index).toBe(0);
    expect(parsed.tabs![0]!.url).toBe("https://a.example/");
    expect(parsed.tabs![0]!.active).toBe(false);
    expect(parsed.tabs![1]!.active).toBe(true);
  });

  test("new creates a page, swaps session.page, clears refs, and navigates if url given", async () => {
    const initial = makeFakeTabPage("initial", "https://a.example/");
    let gotoCalls: Array<{ url: string }> = [];
    const fresh = makeFakeTabPage("fresh", "https://c.example/");
    fresh.goto = (async (url: string) => {
      gotoCalls.push({ url });
      return null;
    }) as unknown as import("playwright-core").Page["goto"];
    const pages = [initial];
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => pages) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => {
        pages.push(fresh);
        return fresh;
      }) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-new", initial, context);
    // Plant a stale ref so we can prove it gets cleared.
    const staleRefs = new Map<string, unknown>();
    staleRefs.set("@e1", { _stale: true });
    browserTest.setFakeSessionRefsForTest("tabs-new", staleRefs);

    const raw = await browserTabs("tabs-new", { action: "new", url: "https://c.example/" });
    const parsed = JSON.parse(raw) as { success: boolean; url?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.url).toBe("https://c.example/");
    expect(gotoCalls.length).toBe(1);
    expect(gotoCalls[0]!.url).toBe("https://c.example/");
    // session.page should have been swapped to the new tab.
    const activePage = browserTest.getFakeSessionPageForTest("tabs-new") as FakeTabPage | undefined;
    expect(activePage?._label).toBe("fresh");
    // Refs map should be a fresh empty map (we wrote a stale entry pre-call,
    // and snapshot on the fresh page returns no rows in our fake walker).
    const refs = browserTest.getFakeSessionRefsForTest("tabs-new");
    expect(refs?.size ?? 0).toBe(0);
  });

  test("new blocks a metadata URL via safetyCheck before opening anything", async () => {
    const initial = makeFakeTabPage("initial", "https://a.example/");
    let newPageCalls = 0;
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => [initial]) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => {
        newPageCalls++;
        return makeFakeTabPage("blocked", "about:blank");
      }) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-block", initial, context);

    const raw = await browserTabs("tabs-block", { action: "new", url: "http://169.254.169.254/" });
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/^Blocked:/);
    expect(newPageCalls).toBe(0);
  });

  test("switch swaps the active page and clears refs", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const p1 = makeFakeTabPage("p1", "https://b.example/");
    const pages = [p0, p1];
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => pages) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => p0) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-switch", p0, context);
    const stale = new Map<string, unknown>();
    stale.set("@e1", {});
    browserTest.setFakeSessionRefsForTest("tabs-switch", stale);

    const raw = await browserTabs("tabs-switch", { action: "switch", index: 1 });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    const active = browserTest.getFakeSessionPageForTest("tabs-switch") as FakeTabPage | undefined;
    expect(active?._label).toBe("p1");
    expect(browserTest.getFakeSessionRefsForTest("tabs-switch")?.size ?? 0).toBe(0);
  });

  test("switch fails for an out-of-range index", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => [p0]) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => p0) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-switch-bad", p0, context);
    const raw = await browserTabs("tabs-switch-bad", { action: "switch", index: 5 });
    expect(JSON.parse(raw).error).toContain("No tab at index 5");
  });

  test("close closes the page, swaps if needed, and clears refs", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const p1 = makeFakeTabPage("p1", "https://b.example/");
    const pages = [p0, p1];
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => pages.filter((p) => !p._closed)) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => makeFakeTabPage("fresh-after-close", "about:blank")) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    // Active page is p1; we'll close it and expect the session to swap to p0.
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-close-active", p1, context);
    const stale = new Map<string, unknown>();
    stale.set("@e1", {});
    browserTest.setFakeSessionRefsForTest("tabs-close-active", stale);

    const raw = await browserTabs("tabs-close-active", { action: "close", index: 1 });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    expect(p1._closed).toBe(true);
    const active = browserTest.getFakeSessionPageForTest("tabs-close-active") as FakeTabPage | undefined;
    expect(active?._label).toBe("p0");
    expect(browserTest.getFakeSessionRefsForTest("tabs-close-active")?.size ?? 0).toBe(0);
  });

  test("close on the last tab opens a fresh tab so session.page isn't dangling", async () => {
    const only = makeFakeTabPage("only", "https://a.example/");
    let newPageCalls = 0;
    const after = makeFakeTabPage("after", "about:blank");
    const pages = [only];
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => pages.filter((p) => !p._closed)) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => {
        newPageCalls++;
        pages.push(after);
        return after;
      }) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-close-last", only, context);

    const raw = await browserTabs("tabs-close-last", { action: "close", index: 0 });
    const parsed = JSON.parse(raw) as { success: boolean };
    expect(parsed.success).toBe(true);
    expect(only._closed).toBe(true);
    expect(newPageCalls).toBe(1);
    const active = browserTest.getFakeSessionPageForTest("tabs-close-last") as FakeTabPage | undefined;
    expect(active?._label).toBe("after");
  });

  test("rejects an unknown action", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => [p0]) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => p0) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-bad-action", p0, context);
    const raw = await browserTabs("tabs-bad-action", { action: "fly" });
    expect(JSON.parse(raw).error).toMatch(/action.*list.*new.*switch.*close/);
  });

  test("rejects missing index on switch/close", async () => {
    const p0 = makeFakeTabPage("p0", "https://a.example/");
    const context: Partial<import("playwright-core").BrowserContext> = {
      pages: (() => [p0]) as unknown as import("playwright-core").BrowserContext["pages"],
      newPage: (async () => p0) as unknown as import("playwright-core").BrowserContext["newPage"]
    };
    browserTest.installFakeSessionWithPageAndContextForTest("tabs-missing-index", p0, context);
    const rawSwitch = await browserTabs("tabs-missing-index", { action: "switch" });
    expect(JSON.parse(rawSwitch).error).toMatch(/non-negative integer/);
    const rawClose = await browserTabs("tabs-missing-index", { action: "close" });
    expect(JSON.parse(rawClose).error).toMatch(/non-negative integer/);
  });
});

describe("browserUploadFile", () => {
  const UPLOAD_ROOT = "/tmp/gini-browser-upload-tests";
  const WORKSPACE = join(UPLOAD_ROOT, "workspace");
  const OUTSIDE = join(UPLOAD_ROOT, "outside");

  beforeEach(() => {
    rmSync(UPLOAD_ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    mkdirSync(OUTSIDE, { recursive: true });
  });

  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    rmSync(UPLOAD_ROOT, { recursive: true, force: true });
  });

  test("uploads a workspace file via locator.setInputFiles using the realpath", async () => {
    writeFileSync(join(WORKSPACE, "upload.txt"), "hello\n");
    const fakePage = makeFakePageForRefTools("https://example.com/form");
    browserTest.installFakeSessionWithPageForTest("upload-ok", fakePage);
    let captured: { files?: unknown; timeout?: number } | undefined;
    const loc = {
      setInputFiles: async (files: unknown, opts?: { timeout?: number }) => {
        captured = { files, timeout: opts?.timeout };
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e2", loc);
    browserTest.setFakeSessionRefsForTest("upload-ok", refs);

    const raw = await browserUploadFile("upload-ok", { ref: "@e2", path: "upload.txt" }, WORKSPACE);
    const parsed = JSON.parse(raw) as { success: boolean; path?: string };
    expect(parsed.success).toBe(true);
    expect(parsed.path).toBe("upload.txt");
    expect(captured).toBeDefined();
    expect(captured!.timeout).toBe(10_000);
    // realpath of /tmp/... resolves to /private/tmp/... on macOS, so we
    // only assert the file portion is correct and that the path was
    // run through realpath (i.e. it's absolute and ends with upload.txt).
    expect(typeof captured!.files).toBe("string");
    expect(String(captured!.files).endsWith("/upload.txt")).toBe(true);
  });

  test("rejects a path outside the workspace", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("upload-escape", fakePage);
    const raw = await browserUploadFile(
      "upload-escape",
      { ref: "@e1", path: "../outside/secret.txt" },
      WORKSPACE
    );
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/outside workspace/);
  });

  test("rejects a path that doesn't exist", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("upload-missing", fakePage);
    const raw = await browserUploadFile(
      "upload-missing",
      { ref: "@e1", path: "nope.txt" },
      WORKSPACE
    );
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/does not exist/);
  });

  test("rejects a path that points at a directory", async () => {
    mkdirSync(join(WORKSPACE, "subdir"));
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("upload-dir", fakePage);
    const raw = await browserUploadFile(
      "upload-dir",
      { ref: "@e1", path: "subdir" },
      WORKSPACE
    );
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/not a file/);
  });

  test("rejects a symlink whose target resolves outside the workspace", async () => {
    writeFileSync(join(OUTSIDE, "secret.txt"), "top secret\n");
    symlinkSync(join(OUTSIDE, "secret.txt"), join(WORKSPACE, "evil-link.txt"));
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("upload-symlink", fakePage);
    let setInputCalls = 0;
    const loc = {
      setInputFiles: async () => {
        setInputCalls++;
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e1", loc);
    browserTest.setFakeSessionRefsForTest("upload-symlink", refs);

    const raw = await browserUploadFile(
      "upload-symlink",
      { ref: "@e1", path: "evil-link.txt" },
      WORKSPACE
    );
    const parsed = JSON.parse(raw) as { success: boolean; error?: string };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/symlink/);
    // Must NOT have reached setInputFiles.
    expect(setInputCalls).toBe(0);
  });

  test("rejects missing ref argument", async () => {
    const raw = await browserUploadFile("upload-no-ref", { path: "x.txt" }, WORKSPACE);
    expect(JSON.parse(raw).error).toMatch(/ref/);
  });

  test("rejects missing path argument", async () => {
    const raw = await browserUploadFile("upload-no-path", { ref: "@e1" }, WORKSPACE);
    expect(JSON.parse(raw).error).toMatch(/path/);
  });

  test("returns Unknown ref when path is valid but ref isn't in the latest snapshot", async () => {
    writeFileSync(join(WORKSPACE, "ok.txt"), "ok\n");
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("upload-bad-ref", fakePage);
    const raw = await browserUploadFile(
      "upload-bad-ref",
      { ref: "@e99", path: "ok.txt" },
      WORKSPACE
    );
    expect(JSON.parse(raw).error).toContain("Unknown ref @e99");
  });
});

// browser_upload_file dispatched through the chat-task tool dispatcher must
// route through the approval gate (file egress is irreversible from the
// user's perspective and gets a high-risk row, same as file_write).
describe("dispatchToolCall(browser_upload_file)", () => {
  const ROOT = "/tmp/gini-browser-upload-dispatch-tests";
  const WORKSPACE = join(ROOT, "workspace");

  function dispatchConfig(instance: string): RuntimeConfig {
    process.env.GINI_STATE_ROOT = ROOT;
    process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    return {
      instance,
      port: 7339,
      token: "test-token",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: WORKSPACE,
      stateRoot: `${ROOT}/instances/${instance}`,
      logRoot: `${ROOT}-logs/${instance}`
    };
  }

  test("returns kind:'pending' with an approval row at risk 'high'", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    writeFileSync(join(WORKSPACE, "report.txt"), "hello upload\n");
    const config = dispatchConfig("browser-upload-dispatch");
    // The dispatcher needs a real task row to attach the approval to.
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "upload test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "browser_upload_file",
      "call_upload_1",
      JSON.stringify({ ref: "@e3", path: "report.txt" })
    );
    expect(result.kind).toBe("pending");

    const state = readState(config.instance);
    const approval = state.approvals.find((a) =>
      result.kind === "pending" && a.id === result.approvalId
    );
    expect(approval).toBeDefined();
    expect(approval!.risk).toBe("high");
    expect(approval!.action).toBe("browser.upload_file");
    expect(approval!.target).toBe("report.txt");
    // Approval payload carries enough for the executor to act without
    // re-walking the workspace.
    expect(approval!.payload.ref).toBe("@e3");
    expect(approval!.payload.path).toBe("report.txt");
    expect(typeof approval!.payload.resolvedPath).toBe("string");
    expect(String(approval!.payload.resolvedPath).endsWith("/report.txt")).toBe(true);
    expect(approval!.payload.toolCallId).toBe("call_upload_1");

    rmSync(ROOT, { recursive: true, force: true });
  });

  test("propagates outside-workspace path errors instead of opening an approval", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-upload-dispatch-escape");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "upload escape", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "browser_upload_file",
        "call_upload_escape_1",
        JSON.stringify({ ref: "@e1", path: "../escape.txt" })
      )
    ).rejects.toThrow(/outside workspace/);
    // No approval row should exist.
    const state = readState(config.instance);
    expect(state.approvals.length).toBe(0);

    rmSync(ROOT, { recursive: true, force: true });
  });
});

// dispatchToolCall(browser_vision) must accumulate the vision provider's
// token spend into task.cost so the chat UI's running total reflects
// out-of-band side calls. The browserVision tool returns the cost in its
// JSON envelope; the dispatcher rolls it into the task row via mutateState.
describe("dispatchToolCall(browser_vision) cost accumulation", () => {
  const ROOT = "/tmp/gini-browser-vision-dispatch-tests";

  function dispatchConfig(instance: string): RuntimeConfig {
    process.env.GINI_STATE_ROOT = ROOT;
    process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
    return {
      instance,
      port: 7339,
      token: "test-token",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: `${ROOT}/instances/${instance}`,
      logRoot: `${ROOT}-logs/${instance}`
    };
  }

  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
    clearEchoVisionResponses();
  });

  test("vision usage block accumulates into the task's cost row", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    const config = dispatchConfig("browser-vision-dispatch");
    // Build the task row the dispatcher will route the call against.
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "vision test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    // Plant the fake session + canned vision response.
    const fakePage = {
      screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]),
      url: () => "https://example.com/cost"
    };
    browserTest.installFakeSessionWithPageForTest(taskId, fakePage);
    setEchoVisionResponse({
      text: "looks fine",
      cost: {
        provider: "echo",
        model: "gini-echo-v0",
        inputTokens: 250,
        outputTokens: 50,
        totalTokens: 300,
        estimatedUsd: 0.0003
      }
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "browser_vision",
      "call_vision_1",
      JSON.stringify({ question: "what is on the page?" })
    );
    expect(result.kind).toBe("sync");

    // The task row's cost should now reflect the vision provider's spend.
    const after = readState(config.instance).tasks.find((t) => t.id === taskId);
    expect(after?.cost).toBeDefined();
    expect(after!.cost!.totalTokens).toBe(300);
    expect(after!.cost!.inputTokens).toBe(250);
    expect(after!.cost!.outputTokens).toBe(50);
    expect(after!.cost!.estimatedUsd).toBeCloseTo(0.0003, 5);

    rmSync(ROOT, { recursive: true, force: true });
  });
});

// closeSession must drain agent-opened tabs (tracked via ownedPageIds) so
// the user's window/tabs stay alive while the agent's scratch pages are
// closed when the task ends.
describe("closeSession drains agent-owned pages", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("each agent-opened tab is closed via its close() handle", async () => {
    // Plant a session with 3 agent-owned pages. The fake context returns
    // those pages from .pages() (no user-owned tabs in this scenario).
    const closed: string[] = [];
    const makePage = (label: string): Partial<import("playwright-core").Page> => ({
      url: () => `https://example.com/${label}`,
      title: () => Promise.resolve(label),
      close: (async () => {
        closed.push(label);
      }) as unknown as import("playwright-core").Page["close"]
    });
    const p0 = makePage("p0");
    const p1 = makePage("p1");
    const p2 = makePage("p2");
    // Install with p0 as the active page, then manually extend
    // ownedPageIds to include p1 + p2 (mimicking two browser_tabs:new
    // calls during the task).
    browserTest.installFakeSessionWithPageForTest("drain-pages-task", p0);
    const session = browserTest.getFakeSessionForTest("drain-pages-task");
    expect(session).toBeDefined();
    session!.ownedPageIds.add(p1 as unknown as import("playwright-core").Page);
    session!.ownedPageIds.add(p2 as unknown as import("playwright-core").Page);

    await browserTest.closeSessionForTest("drain-pages-task");

    // All three agent-owned pages should have had close() called.
    expect(closed.sort()).toEqual(["p0", "p1", "p2"]);
  });
});

// browser_select_option should accept an option ref alone and walk up to
// the containing <select>, using the option's `value` attribute when the
// caller didn't supply an explicit value/values.
describe("browserSelectOption option-ref inference", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("walks up from an OPTION to its parent SELECT and uses the option's value attribute", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-option-ref", fakePage);

    // The option locator: evaluate returns { tagName: "OPTION", value: "bmw" }.
    // .locator("xpath=...") returns a new fake "select" locator whose
    // selectOption() captures the call so the test can assert it ran with
    // "bmw".
    let captured: { selection: unknown; timeout?: number } | undefined;
    const selectLocator = {
      selectOption: async (selection: unknown, opts?: { timeout?: number }) => {
        captured = { selection, timeout: opts?.timeout };
        return [];
      }
    };
    const optionLocator = {
      evaluate: async (_fn: (el: Element) => { tagName: string; value: string }) =>
        ({ tagName: "OPTION", value: "bmw" }),
      locator: (selector: string) => {
        // Must walk via xpath up to the parent select.
        if (selector !== "xpath=ancestor::select[1]") {
          throw new Error(`Unexpected selector: ${selector}`);
        }
        return selectLocator;
      }
    };
    const refs = new Map<string, unknown>();
    refs.set("@e5", optionLocator);
    browserTest.setFakeSessionRefsForTest("sel-option-ref", refs);

    const raw = await browserSelectOption("sel-option-ref", { ref: "@e5" });
    const parsed = JSON.parse(raw) as { success: boolean; selected?: unknown };
    expect(parsed.success).toBe(true);
    expect(parsed.selected).toBe("bmw");
    expect(captured).toBeDefined();
    expect(captured!.selection).toBe("bmw");
    expect(captured!.timeout).toBe(10_000);
  });

  test("explicit value overrides the option's value attribute when an option ref is supplied", async () => {
    const fakePage = makeFakePageForRefTools();
    browserTest.installFakeSessionWithPageForTest("sel-option-override", fakePage);

    let captured: { selection: unknown } | undefined;
    const selectLocator = {
      selectOption: async (selection: unknown) => {
        captured = { selection };
        return [];
      }
    };
    const optionLocator = {
      evaluate: async () => ({ tagName: "OPTION", value: "bmw" }),
      locator: () => selectLocator
    };
    const refs = new Map<string, unknown>();
    refs.set("@e5", optionLocator);
    browserTest.setFakeSessionRefsForTest("sel-option-override", refs);

    const raw = await browserSelectOption("sel-option-override", { ref: "@e5", value: "audi" });
    const parsed = JSON.parse(raw) as { success: boolean; selected?: unknown };
    expect(parsed.success).toBe(true);
    // Explicit value wins over the inferred option value.
    expect(parsed.selected).toBe("audi");
    expect(captured!.selection).toBe("audi");
  });
});

// currentDisconnectGeneration is the read-only counter used by browserVision
// to detect a teardown that happens between screenshot and provider response.
describe("currentDisconnectGeneration", () => {
  afterEach(() => {
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("returns the same value the test-helper exposes", () => {
    const before = browserTest.currentDisconnectGenerationForTest();
    expect(currentDisconnectGeneration()).toBe(before);
    const after = browserTest.bumpDisconnectGenerationForTest();
    expect(currentDisconnectGeneration()).toBe(after);
  });
});
