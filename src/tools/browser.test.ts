import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  __test as browserTest,
  browserClick,
  browserConsole,
  browserDrag,
  browserHover,
  browserNavigate,
  browserSelectOption,
  browserSnapshot,
  browserTabs,
  browserUploadFile,
  browserVision,
  browserWaitFor,
  chromeProfileDirFor,
  closeAll,
  currentDisconnectGeneration,
  disconnectSharedBrowser,
  hostnameIsLoopback,
  redactSecretValuesFromString,
  safetyCheck,
  setBrowserInstance,
  withTeardownLock
} from "./browser";
import { dispatchToolCall } from "../execution/tool-dispatch";
import { resolveSetupRequest } from "../agent";
import { completeBrowserConnectSetup } from "../capabilities/browser-connect";
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

  test("trailing-dot bypass: localhost. / 127.0.0.1. are still loopback", () => {
    // DNS roots can be written with a trailing "." and resolvers
    // treat them as equivalent to the dotless form. Without the
    // strip, endsWith(".localhost") would miss "localhost.", and the
    // BLOCKED_HOSTNAMES literal check would miss "127.0.0.1.".
    for (const url of ["http://localhost./api", "http://127.0.0.1./api"]) {
      const result = safetyCheck(url);
      expect(result).toBeDefined();
      expect(result).toContain("loopback");
    }
  });

  test("IPv4-compat IPv6 hex loopback bypass: [::7f00:1] decodes to 127.0.0.1", () => {
    // Bun's URL parser normalizes [::127.0.0.1] to [::7f00:1] (hex
    // IPv4-compat), so the literal-match path never sees the dotted
    // form. The hex decoder must recognize it.
    const result = safetyCheck("http://[::7f00:1]/");
    expect(result).toBeDefined();
    expect(result).toContain("loopback");
  });

  test("allowLoopback opts out of the loopback block for CDP-style callers", () => {
    // browser-connect attaches over CDP to a local Chrome. The CDP
    // endpoint is always loopback by design — refusing it would
    // break legitimate browser attach. Pin that the opt-out works
    // for representative loopback variants but the OTHER blocks
    // (metadata, link-local) still fire.
    expect(safetyCheck("http://127.0.0.1:9222/", { allowLoopback: true })).toBeUndefined();
    expect(safetyCheck("http://localhost:9222/", { allowLoopback: true })).toBeUndefined();
    expect(safetyCheck("http://[::1]:9222/", { allowLoopback: true })).toBeUndefined();
    // Metadata IP is NOT loopback — still blocked even with the opt-out.
    expect(safetyCheck("http://169.254.169.254/", { allowLoopback: true })).toBeDefined();
  });

  test("IPv4-mapped IPv6 loopback respects allowLoopback (CDP attach)", () => {
    // CDP attach can legitimately receive [::ffff:127.0.0.1]:9222
    // because Bun normalizes various IPv6 spellings. The decoder
    // now translates the mapped IPv6 to its IPv4 form BEFORE the
    // loopback check, so allowLoopback applies uniformly across
    // [127.0.0.1], [::1], [::ffff:127.0.0.1] (dot-quad), and
    // [::ffff:7f00:1] (hex). Without the decoder, the IPv6 branch
    // would route the mapped form through the metadata path and
    // refuse it even under allowLoopback.
    expect(safetyCheck("http://[::ffff:127.0.0.1]:9222/", { allowLoopback: true })).toBeUndefined();
    expect(safetyCheck("http://[::ffff:7f00:1]:9222/", { allowLoopback: true })).toBeUndefined();
    // Same forms WITHOUT allowLoopback are still refused (with the
    // correct loopback message, not the legacy metadata one).
    const blocked = safetyCheck("http://[::ffff:127.0.0.1]/");
    expect(blocked).toBeDefined();
    expect(blocked).toContain("loopback");
    const blocked2 = safetyCheck("http://[::ffff:7f00:1]/");
    expect(blocked2).toBeDefined();
    expect(blocked2).toContain("loopback");
  });

  test("blocks loopback navigation (BFF / runtime SSRF surface)", () => {
    // The BFF's catch-all /api/runtime/* proxy injects the runtime
    // bearer for safe-method loopback requests, so an agent that
    // navigates the controlled browser to its own host can read
    // runtime state (including messaging.approve_pairing payloads).
    // Pin that the loopback variants are all refused — IPv4 literal,
    // IPv6 literal, 0.0.0.0, the localhost hostname, and the 127/8
    // range and *.localhost.
    const refused = [
      "http://127.0.0.1:3082/api/runtime/approvals",
      "http://localhost:3082/api/state",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://127.5.5.5/",
      "http://example.localhost/"
    ];
    for (const url of refused) {
      const result = safetyCheck(url);
      expect(result).toBeDefined();
      expect(result!.startsWith("Blocked:")).toBe(true);
      expect(result).toContain("loopback");
    }
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
    // Passing "default" matches the production end-user instance.
    setBrowserInstance("default");
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
    browserTest.resetTeardownCloseTimeoutForTest();
    browserTest.resetChromeKillerForTest();
    browserTest.resetBrowserInstanceForTest();
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
    // Same teardown arm regardless of headed flag — the headless
    // persistent context that the default tool path materializes must
    // come down on Disconnect just like the headed one. Tests the
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

  test("disconnectSharedBrowser bounds a wedged context.close() and force-kills the child", async () => {
    // Reproduces the connect/disconnect hang: a Chromium wedged on a heavy
    // navigation never resolves context.close(). Teardown must give up at
    // the bounded budget and reap the child by its profile-dir pid so the
    // lock frees for the relaunch — instead of hanging for minutes.
    setBrowserInstance("teardown-test-instance");
    browserTest.setTeardownCloseTimeoutForTest(50);
    let killerCalled = false;
    let killerDir: string | undefined;
    browserTest.setChromeKillerForTest((dir) => {
      killerCalled = true;
      killerDir = dir;
      return 1;
    });
    browserTest.installFakeManagedContextForTest({
      close: () => new Promise(() => {})
    });
    const started = Date.now();
    await disconnectSharedBrowser();
    const elapsed = Date.now() - started;
    expect(killerCalled).toBe(true);
    expect(killerDir).toBe(chromeProfileDirFor("teardown-test-instance"));
    expect(elapsed).toBeLessThan(7_000);
  });

  test("disconnectSharedBrowser is not wedged by a per-page close() that never resolves", async () => {
    // A wedged owned-page close() runs BEFORE teardownHandle; bounding it
    // is what lets disconnect reach the context teardown at all.
    browserTest.setTeardownCloseTimeoutForTest(50);
    let contextCloseCalled = false;
    browserTest.installFakeManagedContextForTest({
      close: async () => {
        contextCloseCalled = true;
      }
    });
    browserTest.installFakeSessionForTest("wedged-page-task", 0);
    const session = browserTest.getFakeSessionForTest("wedged-page-task");
    expect(session).toBeDefined();
    session!.ownedPageIds.clear();
    session!.ownedPageIds.add({ close: () => new Promise(() => {}) } as never);
    const started = Date.now();
    await disconnectSharedBrowser();
    const elapsed = Date.now() - started;
    expect(contextCloseCalled).toBe(true);
    expect(elapsed).toBeLessThan(7_000);
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
describe("browserFillByLocator error redaction", () => {
  // Pin the playwright-error-leaks-typed-value gap. Playwright's
  // locator.fill embeds the typed value in its timeout error
  // message via "Call log: fill(\"<value>\")". If that error.message
  // returned verbatim from browserFillByLocator's catch, the
  // bounded module would persist it to the unredacted trace JSONL
  // (errors[] in appendTrace data) and pass it to the agent via
  // resumeChatTask. The catch must run error.message through
  // redactSecretValuesFromString against the per-task registry.
  test("redacts known secrets out of a playwright-style error message", () => {
    // Simulate playwright's actual error shape:
    // Timeout 10000ms exceeded.
    // Call log:
    //   fill("<value>")
    //   waiting for element to be visible, enabled and editable
    const errorWithValue = 'Timeout 10000ms exceeded.\nCall log:\n  fill("hunter2-LEAK-MARKER")\n  waiting for element to be visible, enabled and editable';
    const redacted = redactSecretValuesFromString(errorWithValue, ["hunter2-LEAK-MARKER"]);
    expect(redacted).not.toContain("hunter2-LEAK-MARKER");
    expect(redacted).toContain("[redacted]");
    // Surrounding diagnostic context survives so the agent still
    // sees the failure reason.
    expect(redacted).toContain("Timeout 10000ms exceeded");
    expect(redacted).toContain("waiting for element");
  });
});

describe("redactSecretValuesDeep object-key redaction", () => {
  // An agent can use a computed object key to smuggle the secret
  // out via JSON serialization: `{[input.value]: 1}` produces
  // `{"hunter2": 1}` and `JSON.stringify` writes the key verbatim.
  // The walker must redact both keys and values.
  const { redactSecretValuesDeep } = require("./browser") as typeof import("./browser");

  test("redacts secret bytes when they appear as object keys", () => {
    const result = redactSecretValuesDeep({ "hunter2-LEAK": 1, other: "ok" }, ["hunter2-LEAK"]) as Record<string, unknown>;
    expect(Object.keys(result)).not.toContain("hunter2-LEAK");
    expect(Object.keys(result)).toContain("[redacted]");
    expect(result.other).toBe("ok");
  });

  test("disambiguates collisions when multiple keys redact to the same token", () => {
    const result = redactSecretValuesDeep({
      "alpha-secret": "a",
      "beta-secret": "b",
      kept: "c"
    }, ["alpha-secret", "beta-secret"]) as Record<string, unknown>;
    // Both secret-keyed entries survive without overwriting each other.
    const keys = Object.keys(result).filter((k) => k !== "kept");
    expect(keys.length).toBe(2);
    expect(keys.every((k) => k.startsWith("[redacted]"))).toBe(true);
    expect(result.kept).toBe("c");
  });
});

describe("redactSecretValuesFromString", () => {
  test("replaces every occurrence of every secret with [redacted]", () => {
    const text = "Login attempt with username=tomsmith and password=SuperSecret123. Retried with SuperSecret123 again.";
    const result = redactSecretValuesFromString(text, ["tomsmith", "SuperSecret123"]);
    expect(result).toBe("Login attempt with username=[redacted] and password=[redacted]. Retried with [redacted] again.");
  });

  test("longer secrets are replaced before shorter prefixes (no partial leakage)", () => {
    // If the shorter secret were replaced first, "abc" → "[redacted]"
    // would leave "def" exposed when the agent had typed "abcdef".
    const text = "input was abcdef and another abcdef";
    const result = redactSecretValuesFromString(text, ["abc", "abcdef"]);
    expect(result).toBe("input was [redacted] and another [redacted]");
  });

  test("no-op on empty inputs", () => {
    expect(redactSecretValuesFromString("", ["abc"])).toBe("");
    expect(redactSecretValuesFromString("text", [])).toBe("text");
    expect(redactSecretValuesFromString("text", ["", ""])).toBe("text");
  });

  test("treats secret as literal string, not regex (metacharacters do not break)", () => {
    const text = "user[1]=root password=.*";
    const result = redactSecretValuesFromString(text, ["root", ".*"]);
    expect(result).toBe("user[1]=[redacted] password=[redacted]");
  });
});

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

// Tests for hidden-element surfacing in the snapshot walker. The walker
// must emit invisible interactive elements (with a [hidden] marker) so
// wait_for state:"hidden"/"attached"/"detached" can target them, AND must
// always emit <input type="file"> regardless of visibility so hidden file
// inputs behind styled-button uploaders are still drivable via
// browser_upload_file.
describe("snapshot walker — hidden interactive elements", () => {
  // Shared fake-DOM scaffolding. Each test plants its own document.body,
  // calls __test.snapshotForTest with a fake page that runs the
  // evaluate-callback locally, and restores globals on exit.
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
    _visible: boolean;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    getBoundingClientRect(): { width: number; height: number };
    get children(): FakeEl[];
    get textContent(): string;
    querySelectorAll(selector: string): FakeEl[];
  };
  const makeEl = (init: Partial<FakeEl> & { tagName: string; visible?: boolean; children?: FakeEl[]; textContent?: string; attrs?: Record<string, string> }): FakeEl => {
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
      _attrs: { ...(init.attrs ?? {}) },
      _children: children,
      _textContent: init.textContent ?? "",
      _visible: visible,
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
        return this._visible ? { width: 100, height: 20 } : { width: 0, height: 0 };
      },
      get children() {
        return this._children;
      },
      get textContent() {
        return this._textContent;
      },
      querySelectorAll(selector: string) {
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
  // Installs the fake DOM globals the walker reads from inside the
  // page.evaluate callback (which runs locally under the fake page). The
  // returned `restore` function puts the originals back.
  const installFakeDom = (body: FakeEl): (() => void) => {
    const originalDocument = (globalThis as Record<string, unknown>).document;
    const originalWindow = (globalThis as Record<string, unknown>).window;
    const originalCSS = (globalThis as Record<string, unknown>).CSS;
    (globalThis as unknown as { document: unknown }).document = {
      body,
      querySelectorAll: (selector: string) => body.querySelectorAll(selector),
      querySelector: (_sel: string) => null,
      getElementById: (_id: string) => null
    };
    (globalThis as unknown as { window: unknown }).window = {
      getComputedStyle: (_el: unknown) => ({ display: "block", visibility: "visible" })
    };
    (globalThis as unknown as { CSS: unknown }).CSS = { escape: (s: string) => s };
    return () => {
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
    };
  };

  // Fake Page whose page.evaluate(fn, arg) runs fn(arg) locally; the
  // locator factory returns a synthetic locator stub keyed by selector so
  // the post-walk `refs` map can carry distinct values per ref.
  const makeFakePage = (): { page: import("playwright-core").Page; locatorOf: (sel: string) => unknown } => {
    const fakeLocators = new Map<string, unknown>();
    const page = {
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => Promise.resolve(fn(arg as A)),
      locator: (sel: string) => {
        if (!fakeLocators.has(sel)) fakeLocators.set(sel, { __sel: sel });
        return fakeLocators.get(sel) as unknown;
      }
    } as unknown as import("playwright-core").Page;
    return { page, locatorOf: (sel: string) => fakeLocators.get(sel) };
  };

  test("emits visible button + hidden file input + hidden dialog with [hidden] markers and all three resolve via refs", async () => {
    // <body>
    //   <button>Save</button>
    //   <input type="file" style="display:none">     ← hidden but force-emitted
    //   <div role="dialog" style="display:none">…</div>  ← invisible interactive
    // </body>
    const button = makeEl({ tagName: "BUTTON", textContent: "Save" });
    const fileInput = makeEl({ tagName: "INPUT", type: "file", visible: false });
    const dialog = makeEl({
      tagName: "DIV",
      visible: false,
      attrs: { role: "dialog" },
      textContent: "Modal content"
    });
    const body = makeEl({ tagName: "BODY", children: [button, fileInput, dialog] });
    const restore = installFakeDom(body);
    const { page } = makeFakePage();
    try {
      const result = await browserTest.snapshotForTest(page, false);

      // Visible button: normal ref + name, no [hidden] annotation.
      expect(result.text).toMatch(/\[@e\d+\] button "Save"/);
      expect(result.text).not.toMatch(/\[@e\d+\] button "Save".*\[hidden\]/);

      // File input: role "file" + [hidden] marker, no name/value noise.
      const fileLine = result.text.split("\n").find((line) => line.includes(" file "));
      expect(fileLine).toBeDefined();
      expect(fileLine).toMatch(/\[@e\d+\] file \[hidden\]/);

      // Hidden dialog: role "dialog" + [hidden] marker.
      const dialogLine = result.text.split("\n").find((line) => line.includes(" dialog"));
      expect(dialogLine).toBeDefined();
      expect(dialogLine).toMatch(/\[@e\d+\] dialog \[hidden\]/);

      // All three refs must resolve via the refs map returned by the
      // walker (this is what session.refs gets populated with).
      const allRefs = Array.from(result.text.matchAll(/\[(@e\d+)\]/g)).map((m) => m[1]!);
      expect(allRefs.length).toBeGreaterThanOrEqual(3);
      for (const ref of allRefs) {
        expect(result.refs.has(ref)).toBe(true);
      }
    } finally {
      restore();
    }
  });

  test("caps hidden entries at 50 and appends [...hidden truncated] marker", async () => {
    const hiddenChildren: FakeEl[] = [];
    for (let i = 0; i < 100; i++) {
      // Each child is a hidden <button> — interactive but offsetParent-less
      // in real Chromium. The walker should emit at most 50 of them.
      hiddenChildren.push(makeEl({ tagName: "BUTTON", visible: false, textContent: `btn-${i}` }));
    }
    const body = makeEl({ tagName: "BODY", children: hiddenChildren });
    const restore = installFakeDom(body);
    const { page } = makeFakePage();
    try {
      const result = await browserTest.snapshotForTest(page, false);
      const hiddenLines = result.text.split("\n").filter((line) => line.includes("[hidden]"));
      expect(hiddenLines.length).toBeLessThanOrEqual(50);
      // We planted 100, so cap must have engaged.
      expect(hiddenLines.length).toBe(50);
      expect(result.text).toContain("[...hidden truncated]");
    } finally {
      restore();
    }
  });
});

// Tests for cursor-interactivity augmentation in the snapshot walker. A
// visible element with no interactive tag and no explicit role still earns
// a ref (role "clickable") when the page signals clickability via computed
// cursor:pointer, an onclick attribute, or tabindex >= 0; inherited cursor
// styles are deduped so only the outermost cursor-qualifying element emits.
// Hidden radio/checkbox inputs with a visible associated <label> are
// force-emitted with [hidden] like file inputs. See ADR
// browser-automation-engine.md.
describe("snapshot walker — cursor-interactive clickables", () => {
  // Fake-DOM scaffolding like the hidden-elements suite above, extended
  // with: per-element computed cursor, parentElement wiring (makeEl links
  // children to their parent), and a document.querySelector that resolves
  // `label[for="..."]` over the planted body tree.
  type FakeEl = {
    tagName: string;
    type?: string;
    value?: string;
    _attrs: Record<string, string>;
    _children: FakeEl[];
    _textContent: string;
    _visible: boolean;
    _cursor: string;
    parentElement: FakeEl | null;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    getBoundingClientRect(): { width: number; height: number };
    get children(): FakeEl[];
    get textContent(): string;
    querySelectorAll(selector: string): FakeEl[];
  };
  const makeEl = (init: {
    tagName: string;
    type?: string;
    value?: string;
    visible?: boolean;
    cursor?: string;
    children?: FakeEl[];
    textContent?: string;
    attrs?: Record<string, string>;
  }): FakeEl => {
    const visible = init.visible ?? true;
    const children = init.children ?? [];
    const el: FakeEl = {
      tagName: init.tagName,
      type: init.type,
      value: init.value,
      _attrs: { ...(init.attrs ?? {}) },
      _children: children,
      _textContent: init.textContent ?? "",
      _visible: visible,
      _cursor: init.cursor ?? "auto",
      parentElement: null,
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
        return this._visible ? { width: 100, height: 20 } : { width: 0, height: 0 };
      },
      get children() {
        return this._children;
      },
      get textContent() {
        return this._textContent;
      },
      querySelectorAll(selector: string) {
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
    for (const child of children) child.parentElement = el;
    return el;
  };
  const installFakeDom = (body: FakeEl): (() => void) => {
    const originalDocument = (globalThis as Record<string, unknown>).document;
    const originalWindow = (globalThis as Record<string, unknown>).window;
    const originalCSS = (globalThis as Record<string, unknown>).CSS;
    const findByLabelFor = (target: string): FakeEl | null => {
      let found: FakeEl | null = null;
      const recurse = (node: FakeEl) => {
        if (found) return;
        if (node.tagName === "LABEL" && node.getAttribute("for") === target) {
          found = node;
          return;
        }
        for (const child of node._children) recurse(child);
      };
      recurse(body);
      return found;
    };
    (globalThis as unknown as { document: unknown }).document = {
      body,
      querySelectorAll: (selector: string) => body.querySelectorAll(selector),
      querySelector: (sel: string) => {
        const m = /^label\[for="(.+)"\]$/.exec(sel);
        return m ? findByLabelFor(m[1]!) : null;
      },
      getElementById: (_id: string) => null
    };
    (globalThis as unknown as { window: unknown }).window = {
      getComputedStyle: (el: unknown) => ({
        display: "block",
        visibility: "visible",
        cursor: (el as FakeEl)._cursor ?? "auto"
      })
    };
    (globalThis as unknown as { CSS: unknown }).CSS = { escape: (s: string) => s };
    return () => {
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
    };
  };
  const makeFakePage = (): import("playwright-core").Page =>
    ({
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => Promise.resolve(fn(arg as A)),
      locator: (sel: string) => ({ __sel: sel } as unknown)
    } as unknown as import("playwright-core").Page);

  test("emits cursor:pointer div as [clickable] once, deduping inherited-cursor descendants", async () => {
    // <body>
    //   <div style="cursor:pointer">Open settings
    //     <span>Open settings</span>      ← inherited cursor, deduped
    //   </div>
    //   <button>Save</button>             ← control: still a plain button
    // </body>
    const span = makeEl({ tagName: "SPAN", cursor: "pointer", textContent: "Open settings" });
    const card = makeEl({ tagName: "DIV", cursor: "pointer", textContent: "Open settings", children: [span] });
    const button = makeEl({ tagName: "BUTTON", textContent: "Save" });
    const body = makeEl({ tagName: "BODY", children: [card, button] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      const clickableLines = result.text.split("\n").filter((line) => line.includes(" clickable "));
      expect(clickableLines.length).toBe(1);
      expect(clickableLines[0]).toMatch(/\[@e\d+\] clickable "Open settings"/);
      // The clickable ref resolves like any other ref.
      const ref = /\[(@e\d+)\]/.exec(clickableLines[0]!)?.[1];
      expect(ref).toBeDefined();
      expect(result.refs.has(ref!)).toBe(true);
      // Native controls are unaffected.
      expect(result.text).toMatch(/\[@e\d+\] button "Save"/);
    } finally {
      restore();
    }
  });

  test("own onclick/tabindex re-qualifies inside a cursor-pointer ancestor; tabindex=-1 and empty names don't", async () => {
    // <div style="cursor:pointer">Cat card
    //   <span onclick="like()">Like</span>       ← own handler, NOT deduped
    //   <span tabindex="0">Share</span>          ← focusable, NOT deduped
    //   <span tabindex="-1">Skip me</span>       ← not focusable, deduped
    // </div>
    // <div style="cursor:pointer"></div>         ← empty name, skipped
    const like = makeEl({ tagName: "SPAN", cursor: "pointer", textContent: "Like", attrs: { onclick: "like()" } });
    const share = makeEl({ tagName: "SPAN", cursor: "pointer", textContent: "Share", attrs: { tabindex: "0" } });
    const skip = makeEl({ tagName: "SPAN", cursor: "pointer", textContent: "Skip me", attrs: { tabindex: "-1" } });
    const card = makeEl({
      tagName: "DIV",
      cursor: "pointer",
      textContent: "Cat card Like Share Skip me",
      children: [like, share, skip]
    });
    const empty = makeEl({ tagName: "DIV", cursor: "pointer", textContent: "" });
    const body = makeEl({ tagName: "BODY", children: [card, empty] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      const clickableLines = result.text.split("\n").filter((line) => line.includes(" clickable "));
      // Card + Like + Share; "Skip me" deduped, empty div skipped.
      expect(clickableLines.length).toBe(3);
      expect(result.text).toContain('clickable "Like"');
      expect(result.text).toContain('clickable "Share"');
      expect(result.text).not.toContain('"Skip me"');
      expect(result.text).not.toContain("[...clickable truncated]");
    } finally {
      restore();
    }
  });

  test("hidden radio/checkbox with a visible label is force-emitted past the hidden budget", async () => {
    // Fill the hidden budget (50) with hidden role=dialog divs so the
    // hidden-element fallback path can't be what emits the toggles — only
    // the label-promotion force-emit can.
    const filler: FakeEl[] = [];
    for (let i = 0; i < 50; i++) {
      filler.push(makeEl({ tagName: "DIV", visible: false, attrs: { role: "dialog" } }));
    }
    // <label>Subscribe <input type="radio" hidden></label>   ← wrapping label
    const radio = makeEl({ tagName: "INPUT", type: "radio", visible: false });
    const wrapLabel = makeEl({ tagName: "LABEL", textContent: "Subscribe", children: [radio] });
    // <input type="checkbox" id="tos" hidden> <label for="tos">Agree</label>
    const checkbox = makeEl({ tagName: "INPUT", type: "checkbox", visible: false, attrs: { id: "tos" } });
    const forLabel = makeEl({ tagName: "LABEL", textContent: "Agree", attrs: { for: "tos" } });
    // <input type="checkbox" hidden>   ← no label: stays on the capped path
    const orphan = makeEl({ tagName: "INPUT", type: "checkbox", visible: false });
    const body = makeEl({ tagName: "BODY", children: [...filler, wrapLabel, checkbox, forLabel, orphan] });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      // Both labeled toggles got refs despite the exhausted hidden budget.
      expect(result.text).toMatch(/\[@e\d+\] radio \[hidden\]/);
      expect(result.text).toMatch(/\[@e\d+\] checkbox \[hidden\]/);
      // The orphan checkbox was over the hidden budget — exactly one
      // checkbox line means the labeled one is the one that surfaced.
      const checkboxLines = result.text.split("\n").filter((line) => line.includes(" checkbox "));
      expect(checkboxLines.length).toBe(1);
    } finally {
      restore();
    }
  });

  test("caps clickable emissions at 75 and appends [...clickable truncated] marker", async () => {
    const children: FakeEl[] = [];
    for (let i = 0; i < 80; i++) {
      // onclick (not cursor) so ancestor dedupe can't interfere with the count.
      children.push(makeEl({ tagName: "DIV", textContent: `row-${i}`, attrs: { onclick: "go()" } }));
    }
    const body = makeEl({ tagName: "BODY", children });
    const restore = installFakeDom(body);
    try {
      const result = await browserTest.snapshotForTest(makeFakePage(), false);
      const clickableLines = result.text.split("\n").filter((line) => line.includes(" clickable "));
      expect(clickableLines.length).toBe(75);
      expect(result.text).toContain("[...clickable truncated]");
    } finally {
      restore();
    }
  });
});

// Feature coverage for stable refs + post-action snapshot diffing: the
// walker reuses an element's existing data-gini-ref stamp across
// snapshots (new ids only for unstamped elements, allocation never
// reuses a retired id), stamps/numbering reset only on navigation, and
// action handlers return a line diff against the previous redacted
// snapshot when the change is small. Explicit browser_snapshot always
// returns the full tree.
describe("snapshot stable refs and post-action diffs", () => {
  type FakeEl = {
    tagName: string;
    type?: string;
    value?: string;
    _attrs: Record<string, string>;
    _children: FakeEl[];
    _textContent: string;
    _visible: boolean;
    parentElement: FakeEl | null;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    getBoundingClientRect(): { width: number; height: number };
    get children(): FakeEl[];
    get textContent(): string;
    querySelectorAll(selector: string): FakeEl[];
  };
  const makeEl = (init: {
    tagName: string;
    type?: string;
    value?: string;
    visible?: boolean;
    children?: FakeEl[];
    textContent?: string;
    attrs?: Record<string, string>;
  }): FakeEl => {
    const visible = init.visible ?? true;
    const children = init.children ?? [];
    const el: FakeEl = {
      tagName: init.tagName,
      type: init.type,
      value: init.value,
      _attrs: { ...(init.attrs ?? {}) },
      _children: children,
      _textContent: init.textContent ?? "",
      _visible: visible,
      parentElement: null,
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
        return this._visible ? { width: 100, height: 20 } : { width: 0, height: 0 };
      },
      get children() {
        return this._children;
      },
      get textContent() {
        return this._textContent;
      },
      querySelectorAll(selector: string) {
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
    for (const child of children) child.parentElement = el;
    return el;
  };
  const installFakeDom = (body: FakeEl): (() => void) => {
    const originalDocument = (globalThis as Record<string, unknown>).document;
    const originalWindow = (globalThis as Record<string, unknown>).window;
    const originalCSS = (globalThis as Record<string, unknown>).CSS;
    (globalThis as unknown as { document: unknown }).document = {
      body,
      querySelectorAll: (selector: string) => body.querySelectorAll(selector),
      querySelector: (_sel: string) => null,
      getElementById: (_id: string) => null
    };
    (globalThis as unknown as { window: unknown }).window = {
      getComputedStyle: (_el: unknown) => ({ display: "block", visibility: "visible", cursor: "auto" })
    };
    (globalThis as unknown as { CSS: unknown }).CSS = { escape: (s: string) => s };
    return () => {
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
    };
  };
  // Fake Page whose evaluate(fn, arg) runs fn(arg) locally and whose
  // locator(sel) returns a stub locator with a click() that invokes the
  // test-provided mutation — so browserClick can "change the page".
  const makeFakePage = (state: { url: string; onClick?: () => void }): import("playwright-core").Page =>
    ({
      url: () => state.url,
      title: async () => "Example",
      waitForLoadState: async () => undefined,
      evaluate: <A, R>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => Promise.resolve(fn(arg as A)),
      locator: (sel: string) => ({
        __sel: sel,
        click: async (_opts?: { timeout?: number }) => {
          state.onClick?.();
        }
      })
    } as unknown as import("playwright-core").Page);

  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("an element keeps its ref across snapshots; new elements allocate new higher ids", async () => {
    const save = makeEl({ tagName: "BUTTON", textContent: "Save" });
    const email = makeEl({ tagName: "INPUT", type: "text", value: "", attrs: { placeholder: "Email" } });
    const body = makeEl({ tagName: "BODY", children: [save, email] });
    const restore = installFakeDom(body);
    const page = makeFakePage({ url: "https://example.com/" });
    try {
      const first = await browserTest.snapshotForTest(page, false);
      expect(first.text).toContain('[@e1] button "Save"');
      expect(first.text).toContain('[@e2] textbox "Email"');

      const del = makeEl({ tagName: "BUTTON", textContent: "Delete" });
      del.parentElement = body;
      body._children.push(del);

      const second = await browserTest.snapshotForTest(page, false);
      expect(second.text).toContain('[@e1] button "Save"');
      expect(second.text).toContain('[@e2] textbox "Email"');
      expect(second.text).toContain('[@e3] button "Delete"');
      expect(second.refs.has("@e1")).toBe(true);
      expect(second.refs.has("@e3")).toBe(true);
    } finally {
      restore();
    }
  });

  test("a removed element's id is never reused; navigation clears stamps and restarts at @e1", async () => {
    const one = makeEl({ tagName: "BUTTON", textContent: "One" });
    const two = makeEl({ tagName: "BUTTON", textContent: "Two" });
    const body = makeEl({ tagName: "BODY", children: [one, two] });
    const restore = installFakeDom(body);
    const state = { url: "https://a.example/" };
    const page = makeFakePage(state);
    browserTest.installFakeSessionWithPageForTest("ref-nav-task", page as Partial<import("playwright-core").Page>);
    try {
      const first = await browserTest.snapshotForTest(page, false, "ref-nav-task");
      expect(first.text).toContain('[@e1] button "One"');
      expect(first.text).toContain('[@e2] button "Two"');

      // Remove "One" and add "Three": Two keeps @e2, Three gets a fresh
      // @e3 — the retired @e1 is NOT handed to a different element.
      body._children.splice(0, 1);
      const three = makeEl({ tagName: "BUTTON", textContent: "Three" });
      three.parentElement = body;
      body._children.push(three);
      const second = await browserTest.snapshotForTest(page, false, "ref-nav-task");
      expect(second.navigated).toBe(false);
      expect(second.text).toContain('[@e2] button "Two"');
      expect(second.text).toContain('[@e3] button "Three"');
      expect(second.text).not.toContain("[@e1]");

      // URL change = navigation: stamps cleared, numbering restarts.
      state.url = "https://b.example/";
      const third = await browserTest.snapshotForTest(page, false, "ref-nav-task");
      expect(third.navigated).toBe(true);
      expect(third.text).toContain('[@e1] button "Two"');
      expect(third.text).toContain('[@e2] button "Three"');
    } finally {
      restore();
    }
  });

  // Builds a 20-button page so the diff threshold has room to work with
  // (the fixed diff header would dwarf a tiny page's full snapshot and
  // force full mode regardless of the change size).
  const makeButtonRows = (count: number): FakeEl[] => {
    const rows: FakeEl[] = [];
    for (let i = 1; i <= count; i++) {
      rows.push(makeEl({ tagName: "BUTTON", textContent: `Item${String(i).padStart(2, "0")}` }));
    }
    return rows;
  };

  test("post-action snapshot returns a diff when the change is small", async () => {
    const body = makeEl({ tagName: "BODY", children: makeButtonRows(20) });
    const restore = installFakeDom(body);
    const state: { url: string; onClick?: () => void } = { url: "https://example.com/" };
    state.onClick = () => {
      const added = makeEl({ tagName: "BUTTON", textContent: "NewButton" });
      added.parentElement = body;
      body._children.push(added);
    };
    const page = makeFakePage(state);
    browserTest.installFakeSessionWithPageForTest("diff-small", page as Partial<import("playwright-core").Page>);
    try {
      const baseline = JSON.parse(await browserSnapshot("diff-small", {})) as { success: boolean; snapshot: string };
      expect(baseline.success).toBe(true);
      expect(baseline.snapshot).toContain('[@e1] button "Item01"');

      const raw = await browserClick("diff-small", { ref: "@e1" });
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; snapshotMode: string };
      expect(parsed.success).toBe(true);
      expect(parsed.snapshotMode).toBe("diff");
      expect(parsed.snapshot).toContain("[diff vs previous snapshot");
      // The "+ " marker is followed by the line's own depth indent.
      expect(parsed.snapshot).toMatch(/\+\s+\[@e21\] button "NewButton"/);
      // Unchanged lines far from the change are omitted.
      expect(parsed.snapshot).not.toContain("Item05");
    } finally {
      restore();
    }
  });

  test("post-action snapshot returns the full tree when the change is large", async () => {
    const body = makeEl({ tagName: "BODY", children: makeButtonRows(3) });
    const restore = installFakeDom(body);
    const state: { url: string; onClick?: () => void } = { url: "https://example.com/" };
    state.onClick = () => {
      const fresh: FakeEl[] = [];
      for (let i = 1; i <= 8; i++) {
        fresh.push(makeEl({ tagName: "BUTTON", textContent: `Other${i}` }));
      }
      for (const el of fresh) el.parentElement = body;
      body._children.splice(0, body._children.length, ...fresh);
    };
    const page = makeFakePage(state);
    browserTest.installFakeSessionWithPageForTest("diff-large", page as Partial<import("playwright-core").Page>);
    try {
      await browserSnapshot("diff-large", {});
      const raw = await browserClick("diff-large", { ref: "@e1" });
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; snapshotMode: string };
      expect(parsed.success).toBe(true);
      expect(parsed.snapshotMode).toBe("full");
      expect(parsed.snapshot).not.toContain("[diff vs previous snapshot");
      expect(parsed.snapshot).toContain('button "Other1"');
    } finally {
      restore();
    }
  });

  test("first snapshot after a navigation is full even from an action handler", async () => {
    const body = makeEl({ tagName: "BODY", children: makeButtonRows(20) });
    const restore = installFakeDom(body);
    const state: { url: string; onClick?: () => void } = { url: "https://example.com/" };
    state.onClick = () => {
      state.url = "https://example.com/next";
    };
    const page = makeFakePage(state);
    browserTest.installFakeSessionWithPageForTest("diff-nav", page as Partial<import("playwright-core").Page>);
    try {
      await browserSnapshot("diff-nav", {});
      const raw = await browserClick("diff-nav", { ref: "@e1" });
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; snapshotMode: string };
      expect(parsed.success).toBe(true);
      expect(parsed.snapshotMode).toBe("full");
      expect(parsed.snapshot).not.toContain("[diff vs previous snapshot");
      expect(parsed.snapshot).toContain('[@e1] button "Item01"');
    } finally {
      restore();
    }
  });

  test("explicit browser_snapshot always returns the full tree", async () => {
    const body = makeEl({ tagName: "BODY", children: makeButtonRows(20) });
    const restore = installFakeDom(body);
    const page = makeFakePage({ url: "https://example.com/" });
    browserTest.installFakeSessionWithPageForTest("snap-full", page as Partial<import("playwright-core").Page>);
    try {
      await browserSnapshot("snap-full", {});
      // Mutate the page between snapshots — explicit re-snapshot still
      // returns every line, never a diff.
      const added = makeEl({ tagName: "BUTTON", textContent: "NewButton" });
      added.parentElement = body;
      body._children.push(added);
      const raw = await browserSnapshot("snap-full", {});
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; snapshotMode?: string };
      expect(parsed.success).toBe(true);
      expect(parsed.snapshotMode).toBeUndefined();
      expect(parsed.snapshot).not.toContain("[diff vs previous snapshot");
      expect(parsed.snapshot).toContain('[@e1] button "Item01"');
      expect(parsed.snapshot).toContain('[@e21] button "NewButton"');
    } finally {
      restore();
    }
  });

  test("diff text is computed after redaction — registered secret bytes never appear", async () => {
    const secret = "hunter2-secret-value";
    // A data-gini-secret-stamped input feeds the live-DOM secret
    // collector; a plain Notes input receives the secret bytes on click,
    // simulating a page that copies typed credentials around.
    const secretInput = makeEl({
      tagName: "INPUT",
      type: "text",
      value: secret,
      attrs: { "data-gini-secret": "true", placeholder: "Password" }
    });
    const notes = makeEl({ tagName: "INPUT", type: "text", value: "", attrs: { placeholder: "Notes" } });
    const body = makeEl({ tagName: "BODY", children: [...makeButtonRows(20), secretInput, notes] });
    const restore = installFakeDom(body);
    const state: { url: string; onClick?: () => void } = { url: "https://example.com/" };
    state.onClick = () => {
      notes.value = secret;
    };
    const page = makeFakePage(state);
    browserTest.installFakeSessionWithPageForTest("diff-redact", page as Partial<import("playwright-core").Page>);
    try {
      const baseline = JSON.parse(await browserSnapshot("diff-redact", {})) as { snapshot: string };
      expect(baseline.snapshot).not.toContain(secret);

      const raw = await browserClick("diff-redact", { ref: "@e1" });
      expect(raw).not.toContain(secret);
      const parsed = JSON.parse(raw) as { success: boolean; snapshot: string; snapshotMode: string };
      expect(parsed.success).toBe(true);
      expect(parsed.snapshotMode).toBe("diff");
      expect(parsed.snapshot).toMatch(/\+\s+\[@e22\] textbox "Notes" value="\[redacted\]"/);
    } finally {
      restore();
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

// isHandleAlive must force a relaunch when the underlying Chrome died out
// from under us. After an EXTERNAL kill (crash, or — now that the agent
// launches the user's branded Chrome — the user quitting their everyday
// Chrome) Playwright's context.pages() still returns [] without throwing, so
// the old pages()-only probe reported the dead context as alive and wedged
// every later tool call on a stale handle. The Browser's isConnected() is the
// signal that actually flips on an external kill.
describe("isHandleAlive persistent liveness", () => {
  afterEach(() => {
    browserTest.uninstallFakeBrowserForTest();
  });

  test("reports dead when the persistent context's Browser disconnected", () => {
    browserTest.installFakeHeadlessPersistentContextForTest({
      close: async () => undefined,
      pages: () => [],
      browser: () => ({ isConnected: () => false })
    });
    expect(browserTest.isSharedHandleAliveForTest()).toBe(false);
  });

  test("reports alive when the persistent context's Browser is connected", () => {
    browserTest.installFakeHeadlessPersistentContextForTest({
      close: async () => undefined,
      pages: () => [],
      browser: () => ({ isConnected: () => true })
    });
    expect(browserTest.isSharedHandleAliveForTest()).toBe(true);
  });

  test("assumes alive when no Browser handle is exposed (cannot probe)", () => {
    browserTest.installFakeHeadlessPersistentContextForTest({
      close: async () => undefined,
      pages: () => []
    });
    expect(browserTest.isSharedHandleAliveForTest()).toBe(true);
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
    // Stealth arg is present so navigator.webdriver reads false.
    expect(call.options.args as string[]).toContain(
      "--disable-blink-features=AutomationControlled"
    );
    expect(call.dataDir).toContain("chrome-profile");
    expect(call.dataDir).toContain(instance);
  });

  // Same-task recovery: a cached session whose Chrome was killed mid-task
  // must not be handed back (its page is dead). getOrCreate drops it and
  // ensureShared relaunches, so the next tool call for that task heals.
  test("drops a cached session whose browser was killed and relaunches", async () => {
    const TEST_ROOT = "/tmp/gini-browser-samekill";
    process.env["GINI_STATE_ROOT"] = TEST_ROOT;
    const instance = `samekill-${process.pid}`;
    rmSync(`${TEST_ROOT}/instances/${instance}`, { recursive: true, force: true });
    setBrowserInstance(instance);

    // Pre-install a session for this task whose context's Browser reports
    // disconnected (simulating an external kill after the session was made).
    browserTest.installFakeSessionWithPageAndContextForTest(
      "samekill-task",
      { url: () => "https://example.com/", close: () => Promise.resolve() } as never,
      { browser: () => ({ isConnected: () => false }) } as never
    );

    const launchCalls: Array<{ dataDir: string }> = [];
    mock.module("playwright-core", () => ({
      chromium: {
        executablePath: () => "/fake/path/to/chromium",
        launchPersistentContext: async (dataDir: string) => {
          launchCalls.push({ dataDir });
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
      await browserNavigate("samekill-task", { url: "https://example.com/" });
    } catch {
      // Snapshot wiring may throw on the fake page; the assertion is the relaunch.
    } finally {
      mock.restore();
      browserTest.uninstallFakeBrowserForTest();
      browserTest.clearFakeSessionsForTest();
      browserTest.resetChromiumImportForTest();
      setBrowserInstance("dev");
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }

    // The dead cached session was dropped, so ensureShared relaunched rather
    // than reusing it. Without the liveness check, launch is never called.
    expect(launchCalls.length).toBe(1);
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
    // resolve to undefined for the cleanup pass and an empty walker result
    // for the walk so the snapshot text is just empty. The walker now
    // returns { entries, hiddenEmitted, hiddenTotal, hiddenBudget }; the
    // text-rendering loop reads `.entries` so we mirror that shape.
    evaluate: (async () => ({ entries: [], hiddenEmitted: 0, hiddenTotal: 0, hiddenBudget: 0 })) as unknown as import("playwright-core").Page["evaluate"],
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
      evaluate: (async () => ({ entries: [], hiddenEmitted: 0, hiddenTotal: 0, hiddenBudget: 0 })) as unknown as import("playwright-core").Page["evaluate"],
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
    evaluate: (async () => ({ entries: [], hiddenEmitted: 0, hiddenTotal: 0, hiddenBudget: 0 })) as unknown as import("playwright-core").Page["evaluate"],
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
      logRoot: `${ROOT}-logs/${instance}`,
      // The test asserts the gated path (kind: "pending"). Force
      // strict so the new default-auto policy doesn't auto-resolve
      // the upload approval.
      approvalMode: "strict"
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
    const approval = state.authorizations.find((a) =>
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
    expect(state.authorizations.length).toBe(0);

    rmSync(ROOT, { recursive: true, force: true });
  });
});

// browser_connect dispatched through the chat-task tool dispatcher must
// route through the approval gate (spawning a visible Chrome with a
// per-instance profile is a trust-establishment moment that always
// warrants explicit user consent under "auto" mode; only "yolo" auto-
// approves and "strict" gates everything).
describe("dispatchToolCall(browser_connect)", () => {
  const ROOT = "/tmp/gini-browser-connect-dispatch-tests";
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
      logRoot: `${ROOT}-logs/${instance}`,
      // Default ("auto") mode is the user-facing default. The policy
      // seam routes browser.connect through gate under auto, so this
      // is the expected production shape — no override needed.
      approvalMode: "auto"
    };
  }

  afterEach(() => {
    // Drop any fake session a test installed so the navigate-first
    // precondition can't leak across tests.
    browserTest.clearFakeSessionsForTest();
  });

  test("returns kind:'pending' with an approval row at risk 'medium' and action 'browser.connect'", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "connect test", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    // browser_connect now requires an already-open page (it only clears a
    // sign-in wall the agent already hit), so seed a live session.
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://console.cloud.google.com/welcome",
      close: () => Promise.resolve()
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_connect_1",
      JSON.stringify({ reason: "Sign in to Google Cloud Console" })
    );
    expect(result.kind).toBe("pending");

    const state = readState(config.instance);
    const approval = state.setupRequests.find((a) =>
      result.kind === "pending" && a.id === result.approvalId
    );
    expect(approval).toBeDefined();
    expect(approval!.action).toBe("browser.connect");
    // The reason flows onto the setup-request target so the UI surfaces it
    // prominently in the setup card.
    expect(approval!.target).toBe("Sign in to Google Cloud Console");
    expect(approval!.payload.reason).toBe("Sign in to Google Cloud Console");
    expect(approval!.payload.toolCallId).toBe("call_connect_1");

    rmSync(ROOT, { recursive: true, force: true });
  });

  test("missing reason rejects without creating an approval row", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-missing-reason");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "connect missing reason", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    await expect(
      dispatchToolCall(
        config,
        taskId,
        "browser_connect",
        "call_connect_missing_1",
        JSON.stringify({})
      )
    ).rejects.toThrow(/reason/);
    // No approval row should exist.
    const state = readState(config.instance);
    expect(state.setupRequests.length).toBe(0);

    rmSync(ROOT, { recursive: true, force: true });
  });

  // Navigate-first precondition: a cold browser_connect (no page open yet) is
  // a misuse — the agent should browse headless first and only escalate to a
  // Connect prompt when a navigation hits a sign-in wall. The dispatch must
  // refuse it WITHOUT minting an approval, so the user is never prompted to
  // connect for an ordinary browse-the-web request.
  test("refuses a cold call when no browser page is open, without minting an approval", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-cold");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "connect cold", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    // No browser_navigate has run, so there is no live session / open page.
    const result = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_connect_cold_1",
      JSON.stringify({ reason: "Search hotel prices in Los Angeles" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("browser_navigate");

    // The user must not be prompted — no approval row may exist.
    const state = readState(config.instance);
    expect(state.setupRequests.length).toBe(0);

    rmSync(ROOT, { recursive: true, force: true });
  });

  // Loop guard: a task caps Connect cards per sign-in wall. A first prompt plus
  // one retry is legitimate (mistyped credential, or a genuinely different wall
  // on the same host later in the task), so two cards mint; the third call for
  // the same site is refused with a sync result instead of spamming a third
  // identical card.
  test("caps Connect cards per sign-in wall and refuses beyond the cap", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-loop");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "connect loop", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://www.aircanada.com/login",
      close: () => Promise.resolve()
    });
    const connectCards = () =>
      readState(config.instance).setupRequests.filter(
        (a) => a.taskId === taskId && a.action === "browser.connect"
      ).length;

    // First call: a real Connect card (pending approval).
    const first = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_loop_1",
      JSON.stringify({ reason: "Sign in to Air Canada" })
    );
    expect(first.kind).toBe("pending");
    expect(connectCards()).toBe(1);

    // Second call for the same site: still allowed (a retry is legitimate).
    const second = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_loop_2",
      JSON.stringify({ reason: "Sign in to Air Canada" })
    );
    expect(second.kind).toBe("pending");
    expect(connectCards()).toBe(2);

    // Third call for the same site: refused, no new card.
    const third = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_loop_3",
      JSON.stringify({ reason: "Sign in to Air Canada" })
    );
    expect(third.kind).toBe("sync");
    if (third.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(third.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/twice in this task|blocked on signing in/i);
    // Still exactly two cards — the loop did not spam a third approval.
    expect(connectCards()).toBe(2);

    rmSync(ROOT, { recursive: true, force: true });
  });

  // The cap is per host: hitting it for one site must not block a connect for a
  // different site. Pass distinct `url` args so the resolved hosts differ; the
  // second host still mints a card even after the first host reached the cap.
  test("counts Connect cards per host independently", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-perhost");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "connect per-host", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://www.aircanada.com/login",
      close: () => Promise.resolve()
    });

    // Drive host A to the cap (two cards), then refuse a third.
    const a1 = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_perhost_a1",
      JSON.stringify({ reason: "Sign in to Air Canada", url: "https://www.aircanada.com/login" })
    );
    expect(a1.kind).toBe("pending");
    const a2 = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_perhost_a2",
      JSON.stringify({ reason: "Sign in to Air Canada", url: "https://www.aircanada.com/login" })
    );
    expect(a2.kind).toBe("pending");
    const a3 = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_perhost_a3",
      JSON.stringify({ reason: "Sign in to Air Canada", url: "https://www.aircanada.com/login" })
    );
    expect(a3.kind).toBe("sync");

    // A different host is independent — it still mints its first card.
    const b1 = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_perhost_b1",
      JSON.stringify({ reason: "Sign in to United", url: "https://www.united.com/login" })
    );
    expect(b1.kind).toBe("pending");

    rmSync(ROOT, { recursive: true, force: true });
  });

  // A session can exist but still sit on about:blank (or another non-http(s)
  // page) when nothing real has been navigated to yet. That can't host a
  // sign-in wall, so the navigate-first guard must still refuse — same as a
  // missing session.
  test("refuses when the only session is on about:blank", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-blank");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "connect blank", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "about:blank",
      close: () => Promise.resolve()
    });

    const result = await dispatchToolCall(
      config,
      taskId,
      "browser_connect",
      "call_connect_blank_1",
      JSON.stringify({ reason: "Sign in somewhere" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("browser_navigate");
    expect(readState(config.instance).setupRequests.length).toBe(0);

    rmSync(ROOT, { recursive: true, force: true });
  });

  // End-to-end coverage of the dispatch → approval → executor path. The
  // dispatch must surface a pending approval; once the user approves
  // (here via decideApproval, the same code path /approvals/<id>/approve
  // takes), the executor calls connectBrowser with the strict-managed
  // contract and the result reports `mode: "managed"`. A regression where
  // the dispatch silently reused a stale CDP record (the round-9 finding 1
  // bug) would show up here as `mode: "cdp"` in the executor result.
  test("approving the dispatched approval invokes connectBrowser with mode managed", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-approve");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "connect approve", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });
    // browser_connect requires an already-open page; seed a live session so
    // the dispatch passes its navigate-first precondition before exercising
    // the approval → executor path.
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://console.cloud.google.com/welcome",
      close: () => Promise.resolve()
    });

    // Seed an existing cdp-mode record so the strict-managed path has
    // something to tear down. Without the strict-managed gate this is
    // exactly the shape that would short-circuit and return cdp.
    await mutateState(config.instance, (state) => {
      state.browser = {
        mode: "cdp",
        cdpUrl: "ws://127.0.0.1:9222/devtools/browser/STALE",
        pid: null,
        dataDir: null,
        chromePath: null,
        startedAt: new Date().toISOString()
      };
    });

    // Mock playwright-core so the executor's launchManaged path doesn't
    // actually spawn Chrome. The fake context shape mirrors the one used
    // in the strict-managed unit test.
    const browserMod = await import("./browser");
    browserMod.__test.installFakeCdpBrowserForTest({
      disconnect: async () => undefined,
      close: async () => undefined
    });
    mock.module("playwright-core", () => ({
      chromium: {
        executablePath: () => "/fake/path/to/chromium",
        launchPersistentContext: async () => ({
          browser: () => ({ process: () => ({ pid: 1212 }) }),
          close: async () => undefined
        })
      }
    }));
    browserMod.__test.resetChromiumImportForTest();
    try {
      const result = await dispatchToolCall(
        config,
        taskId,
        "browser_connect",
        "call_connect_approve_1",
        JSON.stringify({ reason: "Sign in to Google Cloud Console" })
      );
      expect(result.kind).toBe("pending");
      if (result.kind !== "pending") throw new Error("unreachable");
      const pendingSetup = readState(config.instance).setupRequests.find((s) => s.id === result.approvalId);
      if (!pendingSetup) throw new Error("setup request not minted");
      const { result: toolResult } = await completeBrowserConnectSetup(config, pendingSetup);
      const setup = await resolveSetupRequest(config, result.approvalId, "complete", {
        actor: "user",
        toolResult,
        resumeChatTask: false
      });
      expect(setup.status).toBe("completed");
      const parsed = JSON.parse(toolResult) as {
        success: boolean;
        connected: boolean;
        mode?: string;
      };
      expect(parsed.success).toBe(true);
      expect(parsed.connected).toBe(true);
      // Strict-managed contract — the executor must NOT silently hand back
      // the cdp record we seeded above.
      expect(parsed.mode).toBe("managed");
      // Persisted record matches.
      const persisted = readState(config.instance).browser;
      expect(persisted?.mode).toBe("managed");
      // Exactly one browser.connect audit row — completeBrowserConnectSetup
      // calls connectBrowser with skipAudit and writes the richer row
      // itself. Two rows would mean the capability's reasonless row
      // leaked alongside.
      const connectRows = readState(config.instance).audit.filter(
        (row) => row.action === "browser.connect"
      );
      expect(connectRows.length).toBe(1);
      // The single row carries the user-facing reason and the setup id.
      expect(connectRows[0]!.approvalId).toBe(result.approvalId);
      expect(connectRows[0]!.target).toBe("Sign in to Google Cloud Console");
    } finally {
      mock.restore();
      browserMod.__test.uninstallFakeBrowserForTest();
      browserMod.__test.clearFakeSessionsForTest();
      browserMod.__test.resetChromiumImportForTest();
      rmSync(ROOT, { recursive: true, force: true });
    }
  });

  // Headless-after-signin: the Workspace setup skill calls
  // browser_connect { headless: true } AFTER the user signs in
  // (and after a browser_close) so the rest of Cloud Console runs
  // invisibly. The dispatch must accept the headless flag from the
  // tool args, carry it through the approval payload, and pass it
  // to connectBrowser when the user approves.
  test("dispatch with headless: true forwards the flag through approval to launchManaged", async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    const config = dispatchConfig("browser-connect-dispatch-headless");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "connect headless", undefined, undefined, undefined, undefined);
      upsertTask(state, task);
      return task.id;
    });

    const browserMod = await import("./browser");
    const launchCalls: Array<{ dataDir: string; options: Record<string, unknown> }> = [];
    mock.module("playwright-core", () => ({
      chromium: {
        executablePath: () => "/fake/path/to/chromium",
        launchPersistentContext: async (dataDir: string, options: Record<string, unknown>) => {
          launchCalls.push({ dataDir, options });
          return {
            browser: () => ({ process: () => ({ pid: 3232 }) }),
            close: async () => undefined
          };
        }
      }
    }));
    browserMod.__test.resetChromiumImportForTest();
    try {
      const result = await dispatchToolCall(
        config,
        taskId,
        "browser_connect",
        "call_connect_headless_1",
        JSON.stringify({
          reason: "Continue Cloud Console setup invisibly",
          headless: true
        })
      );
      expect(result.kind).toBe("pending");
      if (result.kind !== "pending") throw new Error("unreachable");
      const pendingSetup = readState(config.instance).setupRequests.find((s) => s.id === result.approvalId);
      if (!pendingSetup) throw new Error("setup request not minted");
      // Flag rode the setup payload from request -> /complete.
      expect(pendingSetup.payload.headless).toBe(true);
      const { result: toolResult } = await completeBrowserConnectSetup(config, pendingSetup);
      const setup = await resolveSetupRequest(config, result.approvalId, "complete", {
        actor: "user",
        toolResult,
        resumeChatTask: false
      });
      expect(setup.status).toBe("completed");
      const parsed = JSON.parse(toolResult) as {
        success: boolean;
        connected: boolean;
        mode?: string;
        headless?: boolean;
      };
      expect(parsed.success).toBe(true);
      expect(parsed.connected).toBe(true);
      expect(parsed.mode).toBe("managed");
      expect(parsed.headless).toBe(true);
      // Playwright was invoked with headless: true.
      expect(launchCalls.length).toBe(1);
      expect(launchCalls[0]!.options.headless).toBe(true);
      // Persisted record carries the flag for future reconnects.
      const persisted = readState(config.instance).browser;
      expect(persisted?.mode).toBe("managed");
      expect(persisted?.headless).toBe(true);
    } finally {
      mock.restore();
      browserMod.__test.uninstallFakeBrowserForTest();
      browserMod.__test.clearFakeSessionsForTest();
      browserMod.__test.resetChromiumImportForTest();
      rmSync(ROOT, { recursive: true, force: true });
    }
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

// The agent's browser tool is barred from loopback origins so it cannot
// pivot through the local web control plane to forge bearer-injected BFF
// writes (issue #193). hostnameIsLoopback is the shared predicate;
// disallowedOriginReason is the server-side page gate reused by snapshot()
// and browser_console; browser_console adds an in-page assertion that
// closes the check-to-use race the server-side gate alone can't.
describe("hostnameIsLoopback", () => {
  test("classifies loopback variants as loopback", () => {
    for (const h of [
      "127.0.0.1",
      "localhost",
      "0.0.0.0",
      "::1",
      "[::1]",
      "127.5.9.200",
      "LocalHost",
      "app.localhost",
      "localhost.",
      "127.0.0.1."
    ]) {
      expect(hostnameIsLoopback(h)).toBe(true);
    }
  });

  test("passes public hosts and loopback look-alikes", () => {
    for (const h of [
      "example.com",
      "127001.example.com",
      "notlocalhost",
      "10.0.0.1",
      "169.254.169.254",
      "1.2.3.4"
    ]) {
      expect(hostnameIsLoopback(h)).toBe(false);
    }
  });
});

describe("disallowedOriginReason", () => {
  test("loopback url returns the block reason and bounces to about:blank", async () => {
    let gotoTarget: string | undefined;
    const page = {
      url: () => "http://127.0.0.1:7351/api/runtime/setup-requests",
      goto: (async (u: string) => {
        gotoTarget = u;
        return null;
      }) as unknown as import("playwright-core").Page["goto"]
    } as unknown as import("playwright-core").Page;
    const reason = await browserTest.disallowedOriginReasonForTest(page);
    expect(reason).toBeDefined();
    expect(reason!).toContain("loopback");
    expect(gotoTarget).toBe("about:blank");
  });

  test("public url returns undefined and does not bounce", async () => {
    let bounced = false;
    const page = {
      url: () => "https://example.com/",
      goto: (async () => {
        bounced = true;
        return null;
      }) as unknown as import("playwright-core").Page["goto"]
    } as unknown as import("playwright-core").Page;
    expect(await browserTest.disallowedOriginReasonForTest(page)).toBeUndefined();
    expect(bounced).toBe(false);
  });

  test("about:blank, empty url, and missing url() are all treated as safe", async () => {
    const blank = { url: () => "about:blank" } as unknown as import("playwright-core").Page;
    expect(await browserTest.disallowedOriginReasonForTest(blank)).toBeUndefined();
    const empty = { url: () => "" } as unknown as import("playwright-core").Page;
    expect(await browserTest.disallowedOriginReasonForTest(empty)).toBeUndefined();
    const noUrl = {} as unknown as import("playwright-core").Page;
    expect(await browserTest.disallowedOriginReasonForTest(noUrl)).toBeUndefined();
  });

  test("loopback url with no goto() still returns the reason without throwing", async () => {
    const page = {
      url: () => "http://localhost:7351/"
    } as unknown as import("playwright-core").Page;
    const reason = await browserTest.disallowedOriginReasonForTest(page);
    expect(reason).toBeDefined();
    expect(reason!).toContain("loopback");
  });

  test("a goto() that rejects is swallowed; the reason is still returned", async () => {
    const page = {
      url: () => "http://127.0.0.1:7351/",
      goto: (async () => {
        throw new Error("navigation crashed");
      }) as unknown as import("playwright-core").Page["goto"]
    } as unknown as import("playwright-core").Page;
    const reason = await browserTest.disallowedOriginReasonForTest(page);
    expect(reason).toBeDefined();
    expect(reason!).toContain("loopback");
  });

  // snapshot() is the read-path chokepoint: browser_snapshot/click/type/back
  // all route through it. A page that settled on a loopback origin (via JS
  // navigation, meta-refresh, or a link click) must be refused before its
  // contents are read back to the agent.
  test("snapshot() throws and bounces when the page settled on a loopback origin", async () => {
    let gotoTarget: string | undefined;
    const page = {
      url: () => "http://127.0.0.1:7351/api/runtime/whoami",
      goto: (async (u: string) => {
        gotoTarget = u;
        return null;
      }) as unknown as import("playwright-core").Page["goto"]
    } as unknown as import("playwright-core").Page;
    await expect(browserTest.snapshotForTest(page, false)).rejects.toThrow(
      "settled on disallowed URL"
    );
    expect(gotoTarget).toBe("about:blank");
  });
});

describe("browserConsole loopback guard", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("refuses to run console JS on a disallowed origin and bounces it", async () => {
    let gotoTarget: string | undefined;
    let evaluated = false;
    browserTest.installFakeSessionWithPageForTest("console-loopback", {
      url: () => "http://127.0.0.1:7351/api/runtime/setup-requests",
      goto: (async (u: string) => {
        gotoTarget = u;
        return null;
      }) as unknown as import("playwright-core").Page["goto"],
      evaluate: (async () => {
        evaluated = true;
        return undefined;
      }) as unknown as import("playwright-core").Page["evaluate"]
    });
    const out = JSON.parse(await browserConsole("console-loopback", { expression: "1 + 1" })) as {
      success: boolean;
      error?: string;
    };
    expect(out.success).toBe(false);
    expect(out.error).toContain("loopback");
    expect(gotoTarget).toBe("about:blank");
    // Neither the secret collector nor the agent eval should have run.
    expect(evaluated).toBe(false);
  });

  test("in-page assertion blocks when the document origin changed during the race", async () => {
    const savedLocation = (globalThis as { location?: unknown }).location;
    // Server pre-check validated https://example.com, but the document has
    // since committed to a loopback origin — origin mismatch must refuse.
    (globalThis as { location?: unknown }).location = { origin: "http://127.0.0.1:7373" };
    try {
      browserTest.installFakeSessionWithPageForTest("console-race", {
        url: () => "https://example.com/",
        on: (() => undefined) as unknown as import("playwright-core").Page["on"],
        goto: (async () => null) as unknown as import("playwright-core").Page["goto"],
        evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)) as unknown as import("playwright-core").Page["evaluate"]
      });
      const out = JSON.parse(
        await browserConsole("console-race", { expression: "(globalThis.__ranRace = true)" })
      ) as { evalResult: unknown; evalError: string | null };
      expect(out.evalError).toContain("origin changed");
      expect(out.evalResult).toBeNull();
      // The expression must never have executed.
      expect((globalThis as { __ranRace?: boolean }).__ranRace).toBeUndefined();
    } finally {
      (globalThis as { location?: unknown }).location = savedLocation;
      delete (globalThis as { __ranRace?: boolean }).__ranRace;
    }
  });

  test("in-page assertion also blocks a race to a metadata / link-local origin", async () => {
    const savedLocation = (globalThis as { location?: unknown }).location;
    // Origin-pinning covers more than loopback: a race to the cloud-metadata
    // origin (which safetyCheck also refuses) is caught the same way.
    (globalThis as { location?: unknown }).location = { origin: "http://169.254.169.254" };
    try {
      browserTest.installFakeSessionWithPageForTest("console-metadata", {
        url: () => "https://example.com/",
        on: (() => undefined) as unknown as import("playwright-core").Page["on"],
        goto: (async () => null) as unknown as import("playwright-core").Page["goto"],
        evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)) as unknown as import("playwright-core").Page["evaluate"]
      });
      const out = JSON.parse(
        await browserConsole("console-metadata", { expression: "(globalThis.__ranMeta = true)" })
      ) as { evalResult: unknown; evalError: string | null };
      expect(out.evalError).toContain("origin changed");
      expect(out.evalResult).toBeNull();
      expect((globalThis as { __ranMeta?: boolean }).__ranMeta).toBeUndefined();
    } finally {
      (globalThis as { location?: unknown }).location = savedLocation;
      delete (globalThis as { __ranMeta?: boolean }).__ranMeta;
    }
  });

  test("runs the expression normally when the origin is unchanged", async () => {
    const savedLocation = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { origin: "https://example.com" };
    try {
      browserTest.installFakeSessionWithPageForTest("console-ok", {
        url: () => "https://example.com/",
        on: (() => undefined) as unknown as import("playwright-core").Page["on"],
        goto: (async () => null) as unknown as import("playwright-core").Page["goto"],
        evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)) as unknown as import("playwright-core").Page["evaluate"]
      });
      // clear: true also exercises the console-log reset branch.
      const out = JSON.parse(await browserConsole("console-ok", { expression: "40 + 2", clear: true })) as {
        success: boolean;
        evalResult: unknown;
        evalError: string | null;
      };
      expect(out.success).toBe(true);
      expect(out.evalError).toBeNull();
      expect(out.evalResult).toBe(42);
    } finally {
      (globalThis as { location?: unknown }).location = savedLocation;
    }
  });

  // If a navigation commits *during* the eval so the page is on a refused
  // origin by the time the call returns, the result must be withheld AND the
  // captured console output dropped — neither the URL nor the control-plane
  // page's console logs may leak, now or on a later call.
  test("withholds console state and clears captured logs on a post-eval block", async () => {
    const savedLocation = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { origin: "https://example.com" };
    let urlCalls = 0;
    let gotoTarget: string | undefined;
    try {
      browserTest.installFakeSessionWithPageForTest("console-postrace", {
        // Benign on the pre-check read; loopback on every read after the eval.
        url: () => (++urlCalls === 1 ? "https://example.com/" : "http://127.0.0.1:7373/api/runtime/whoami"),
        on: (() => undefined) as unknown as import("playwright-core").Page["on"],
        goto: (async (u: string) => {
          gotoTarget = u;
          return null;
        }) as unknown as import("playwright-core").Page["goto"],
        evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)) as unknown as import("playwright-core").Page["evaluate"]
      });
      // Seed console output as if the control-plane page had logged it.
      browserTest.seedConsoleLogsForTest("console-postrace", [{ type: "error", text: "LOOPBACK-LEAK" }]);
      const out = JSON.parse(await browserConsole("console-postrace", { expression: "1 + 1" })) as {
        success: boolean;
        error?: string;
        url?: string;
        messages?: unknown;
      };
      expect(out.success).toBe(false);
      expect(out.error).toContain("loopback");
      expect(out.url).toBeUndefined();
      expect(out.messages).toBeUndefined();
      expect(gotoTarget).toBe("about:blank");
      // The captured loopback logs must be dropped so a later call can't return them.
      expect(browserTest.getConsoleLogsForTest("console-postrace")).toBeUndefined();
    } finally {
      (globalThis as { location?: unknown }).location = savedLocation;
    }
  });

  test("drops captured console output when the pre-check refuses a loopback page", async () => {
    browserTest.installFakeSessionWithPageForTest("console-preclear", {
      url: () => "http://127.0.0.1:7373/api/runtime/setup-requests",
      goto: (async () => null) as unknown as import("playwright-core").Page["goto"],
      evaluate: (async () => undefined) as unknown as import("playwright-core").Page["evaluate"]
    });
    browserTest.seedConsoleLogsForTest("console-preclear", [{ type: "error", text: "LOOPBACK-LEAK" }]);
    const out = JSON.parse(await browserConsole("console-preclear", { expression: "1 + 1" })) as { success: boolean };
    expect(out.success).toBe(false);
    expect(browserTest.getConsoleLogsForTest("console-preclear")).toBeUndefined();
  });

  test("runs on an about:blank page (null origin)", async () => {
    const savedLocation = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { origin: "null" };
    try {
      browserTest.installFakeSessionWithPageForTest("console-blank", {
        url: () => "about:blank",
        on: (() => undefined) as unknown as import("playwright-core").Page["on"],
        evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)) as unknown as import("playwright-core").Page["evaluate"]
      });
      const out = JSON.parse(await browserConsole("console-blank", { expression: "1 + 1" })) as {
        success: boolean;
        evalResult: unknown;
        evalError: string | null;
      };
      expect(out.success).toBe(true);
      expect(out.evalError).toBeNull();
      expect(out.evalResult).toBe(2);
    } finally {
      (globalThis as { location?: unknown }).location = savedLocation;
    }
  });

  test("redacts and returns captured console messages on success", async () => {
    const savedLocation = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = { origin: "https://example.com" };
    try {
      browserTest.installFakeSessionWithPageForTest("console-msgs", {
        url: () => "https://example.com/",
        on: (() => undefined) as unknown as import("playwright-core").Page["on"],
        evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg)) as unknown as import("playwright-core").Page["evaluate"]
      });
      browserTest.seedConsoleLogsForTest("console-msgs", [{ type: "log", text: "hello-from-page" }]);
      const out = JSON.parse(await browserConsole("console-msgs", { expression: "1 + 1" })) as {
        success: boolean;
        messages: { type: string; text: string }[];
        evalResult: unknown;
      };
      expect(out.success).toBe(true);
      expect(out.evalResult).toBe(2);
      expect(out.messages).toEqual([{ type: "log", text: "hello-from-page" }]);
    } finally {
      (globalThis as { location?: unknown }).location = savedLocation;
      browserTest.seedConsoleLogsForTest("console-msgs", []);
    }
  });

  test("surfaces a thrown error from withSession as a failure envelope", async () => {
    browserTest.setInFlightDisconnectsForTest(1);
    const out = JSON.parse(await browserConsole("console-disconnect", { expression: "1 + 1" })) as {
      success: boolean;
      error?: string;
    };
    expect(out.success).toBe(false);
    expect(out.error).toContain("disconnecting");
  });
});

// browser_vision ships rendered pixels to the vision provider, so it must
// refuse a loopback / metadata / link-local page just like browser_console
// and snapshot() do — otherwise the control plane is exfiltrated as an image.
describe("browserVision loopback guard", () => {
  afterEach(() => {
    browserTest.clearFakeSessionsForTest();
    browserTest.setInFlightDisconnectsForTest(0);
  });

  test("refuses to screenshot a loopback control-plane page and bounces it", async () => {
    let gotoTarget: string | undefined;
    let screenshotCalled = false;
    browserTest.installFakeSessionWithPageForTest("vision-loopback", {
      url: () => "http://127.0.0.1:7373/api/runtime/setup-requests",
      goto: (async (u: string) => {
        gotoTarget = u;
        return null;
      }) as unknown as import("playwright-core").Page["goto"],
      screenshot: (async () => {
        screenshotCalled = true;
        return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      }) as unknown as import("playwright-core").Page["screenshot"]
    });
    const out = JSON.parse(
      await browserVision("vision-loopback", { question: "what is shown?" }, {} as unknown as RuntimeConfig)
    ) as { success: boolean; error?: string };
    expect(out.success).toBe(false);
    expect(out.error).toContain("loopback");
    expect(gotoTarget).toBe("about:blank");
    // The screenshot must never have been taken.
    expect(screenshotCalled).toBe(false);
  });

  test("discards the screenshot if the page navigated to a refused origin during capture", async () => {
    let urlCalls = 0;
    browserTest.installFakeSessionWithPageForTest("vision-postshot", {
      // Benign on the pre-screenshot read; loopback on the post-capture read.
      url: () => (++urlCalls === 1 ? "https://example.com/" : "http://127.0.0.1:7373/"),
      goto: (async () => null) as unknown as import("playwright-core").Page["goto"],
      evaluate: (async () => []) as unknown as import("playwright-core").Page["evaluate"],
      screenshot: (async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])) as unknown as import("playwright-core").Page["screenshot"]
    });
    const out = JSON.parse(
      await browserVision("vision-postshot", { question: "what is shown?" }, {} as unknown as RuntimeConfig)
    ) as { success: boolean; error?: string };
    expect(out.success).toBe(false);
    expect(out.error).toContain("loopback");
  });
});
