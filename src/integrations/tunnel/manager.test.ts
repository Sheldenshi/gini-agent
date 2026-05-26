import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeAppleNoteBody,
  renderSnapshotQr,
  resolveTunnelConfig,
  sanitizeError,
  TunnelManager,
  type TunnelManagerOptions
} from "./manager";
import type { RuntimeConfig } from "../../types";

// Per-process unique scratch root. Two concurrent test runs (or two
// parallel test files in one process) on a fixed path would step on
// each other's state files — `mkdtempSync` gives each invocation a
// fresh directory we own outright.
const scratchRoot = mkdtempSync(join(tmpdir(), "gini-tunnel-tests-"));
const stateRootDir = join(scratchRoot, "state");
const logRootDir = join(scratchRoot, "logs");

// Snapshot the env keys this suite mutates so we can restore them in
// afterAll. Without this, a sibling suite that depends on the original
// process-wide GINI_STATE_ROOT / GINI_LOG_ROOT (or the absence thereof)
// would inherit our scratch overrides when run in the same Bun process.
const envSnapshot: { stateRoot: string | undefined; logRoot: string | undefined } = {
  stateRoot: process.env.GINI_STATE_ROOT,
  logRoot: process.env.GINI_LOG_ROOT
};
// Force `process.platform` to "darwin" for the duration of this
// suite. apple-notes.ts short-circuits both the iCloud availability
// probe and the Notes upsert on non-darwin hosts before the injected
// osascript runner can be invoked. Without the override, tests that
// rely on the injected runner firing (and on observing snapshot
// mutations the runner drives) fail on Linux CI.
const originalPlatform = process.platform;
beforeAll(() => {
  envSnapshot.stateRoot = process.env.GINI_STATE_ROOT;
  envSnapshot.logRoot = process.env.GINI_LOG_ROOT;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});
afterAll(() => {
  if (envSnapshot.stateRoot === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = envSnapshot.stateRoot;
  if (envSnapshot.logRoot === undefined) delete process.env.GINI_LOG_ROOT;
  else process.env.GINI_LOG_ROOT = envSnapshot.logRoot;
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe("resolveTunnelConfig", () => {
  test("generates a fresh secret when the on-disk value is missing", () => {
    const result = resolveTunnelConfig(baseConfig());
    expect(result.mutated).toBe(true);
    expect(result.config.secret).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  test("preserves an existing valid secret", () => {
    const config = baseConfig();
    config.tunnel = { secret: "preserved-secret-1234567890abc" };
    const result = resolveTunnelConfig(config);
    expect(result.mutated).toBe(false);
    expect(result.config.secret).toBe("preserved-secret-1234567890abc");
  });

  test("env var GINI_TUNNEL=1 flips the default enabled flag on", () => {
    const config = baseConfig();
    const result = resolveTunnelConfig(config, { GINI_TUNNEL: "1" });
    expect(result.config.enabled).toBe(true);
  });

  test("explicit config.tunnel.enabled wins over env", () => {
    const config = baseConfig();
    config.tunnel = { enabled: false, secret: "abcdefghij1234567890" };
    const result = resolveTunnelConfig(config, { GINI_TUNNEL: "1" });
    expect(result.config.enabled).toBe(false);
  });

  test("apple notes enabled defaults to false on every platform", () => {
    // The Notes mirror writes the secret-bearing tunnel URL to
    // iCloud, which bypasses bearer auth. We require explicit
    // operator consent before that surface exists, regardless of
    // host platform — pin default-off on both darwin and non-darwin.
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const a = resolveTunnelConfig(baseConfig());
      expect(a.config.appleNotes.enabled).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const b = resolveTunnelConfig(baseConfig());
      expect(b.config.appleNotes.enabled).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test("malformed appleNotes.folder (number) falls back to default and flags mutated", () => {
    // `??` only substitutes on null/undefined, so a hand-edited
    // number would slip through into the resolved string-typed
    // field and crash apple-notes.ts:231 (`value.replace is not a
    // function`). Coerce non-strings to the default and flag
    // mutated so the bad disk value gets cleaned up on next write.
    const config = baseConfig();
    config.tunnel = {
      secret: "abcdefghij1234567890",
      appleNotes: { folder: 42 as unknown as string }
    };
    const result = resolveTunnelConfig(config);
    expect(result.config.appleNotes.folder).toBe("gini");
    expect(result.mutated).toBe(true);
  });

  test("malformed appleNotes.noteName (null) falls back to default and flags mutated", () => {
    // `null` would already substitute under `??`, but the explicit
    // `typeof === "string"` check pins it as non-string and routes
    // it through the same cleanup-write path as other malformed
    // primitives. The disk value gets normalized to the default
    // on the next persist.
    const config = baseConfig();
    config.tunnel = {
      secret: "abcdefghij1234567890",
      appleNotes: { noteName: null as unknown as string }
    };
    const result = resolveTunnelConfig(config);
    expect(result.config.appleNotes.noteName).toBe("gini-tunnel-tunnel-test");
    expect(result.mutated).toBe(true);
  });

  test("malformed appleNotes.account (boolean) falls back to default and flags mutated", () => {
    const config = baseConfig();
    config.tunnel = {
      secret: "abcdefghij1234567890",
      appleNotes: { account: false as unknown as string }
    };
    const result = resolveTunnelConfig(config);
    expect(result.config.appleNotes.account).toBe("iCloud");
    expect(result.mutated).toBe(true);
  });
});

describe("TunnelManager", () => {
  test("start populates the snapshot once the URL appears", async () => {
    setupInstanceDir("tunnel-manager-start");
    const manager = makeManager("tunnel-manager-start", {
      streamChunks: ["INF starting...\n", "INF https://test-vibes-77.trycloudflare.com\n"]
    });
    const snapshot = await manager.start();
    expect(snapshot.publicUrl).toBe(`https://test-vibes-77.trycloudflare.com/${snapshot.secret}`);
    expect(snapshot.cloudflareUrl).toBe("https://test-vibes-77.trycloudflare.com");
    expect(snapshot.observedAt).not.toBeNull();
    await manager.stop();
  });

  test("stop tears down the subprocess and clears the public URL", async () => {
    setupInstanceDir("tunnel-manager-stop");
    const manager = makeManager("tunnel-manager-stop", {
      streamChunks: ["INF https://test-vibes-66.trycloudflare.com\n"]
    });
    await manager.start();
    await manager.stop();
    const snapshot = manager.getSnapshot();
    expect(snapshot.publicUrl).toBeNull();
    expect(snapshot.cloudflareUrl).toBeNull();
  });

  test("Apple Notes push is invoked when iCloud is signed in and disabled flag false", async () => {
    setupInstanceDir("tunnel-manager-notes");
    const calls: string[] = [];
    const manager = makeManager("tunnel-manager-notes", {
      streamChunks: ["INF https://test-vibes-55.trycloudflare.com\n"],
      osascript: async (script) => {
        calls.push(script);
        if (script.includes("name of every account")) {
          return { stdout: "yes\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });
    await manager.start();
    await manager.flushNotes();
    const snapshot = manager.getSnapshot();
    expect(snapshot.appleNotes.available).toBe(true);
    expect(snapshot.appleNotes.lastSyncedAt).not.toBeNull();
    expect(calls.some((script) => script.includes("make new note"))).toBe(true);
    // The runtime log must never contain the secret-bearing public URL.
    // The credential bypasses bearer auth, so persisting it to disk
    // would make stale logs equivalent to a leaked token.
    const logPath = join(logRootDir, "tunnel-manager-notes/runtime.jsonl");
    if (existsSync(logPath)) {
      const contents = readFileSync(logPath, "utf8");
      expect(contents).not.toContain(snapshot.secret);
    }
    await manager.stop();
  });

  test("Apple Notes catch sanitises the publicUrl out of lastError", async () => {
    // osascript surfaces AppleScript runtime errors with the literal
    // source script text quoted in the message. A failure touching the
    // `body:` attribute can echo the bodyHtml fragment carrying the
    // secret-bearing publicUrl — that string must never land on the
    // snapshot in plain text.
    setupInstanceDir("tunnel-manager-notes-error-redaction");
    const secret = "abcd1234efgh5678ijkl9012mnop3456";
    const manager = new TunnelManager({
      instance: "tunnel-manager-notes-error-redaction",
      config: {
        enabled: true,
        secret,
        appleNotes: { enabled: true, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      spawn: () => scriptedChild(["INF https://leaky-tunnel-1.trycloudflare.com\n"]),
      osascript: async (script) => {
        if (script.includes("name of every account")) {
          return { stdout: "yes\n", stderr: "", exitCode: 0 };
        }
        // Simulate AppleScript echoing the body fragment, including the
        // publicUrl, into the error message — the exact failure mode
        // the manager has to defend against.
        throw new Error(
          `osascript: execution error: Can't get folder "x". body was https://leaky-tunnel-1.trycloudflare.com/${secret} (-1728)`
        );
      }
    });
    await manager.start();
    await manager.flushNotes();
    const snapshot = manager.getSnapshot();
    expect(snapshot.appleNotes.lastError).not.toBeNull();
    expect(snapshot.appleNotes.lastError).not.toContain(secret);
    expect(snapshot.appleNotes.lastError).not.toContain(
      `https://leaky-tunnel-1.trycloudflare.com/${secret}`
    );
    // The redacted marker tells operators the message was sanitised
    // rather than truncated — without it, an operator might miss that
    // the error was modified at all.
    expect(snapshot.appleNotes.lastError).toContain("(secret values redacted)");
    await manager.stop();
  });

  test("sanitizeError leaves messages with no secrets untouched", () => {
    const out = sanitizeError("permission denied to access Notes.app", [
      "abcdefg",
      "https://x.trycloudflare.com/abcdefg",
      "https://x.trycloudflare.com"
    ]);
    expect(out).toBe("permission denied to access Notes.app");
    expect(out).not.toContain("(secret values redacted)");
  });

  test("sanitizeError tolerates null/undefined/empty secret slots", () => {
    // `recordStartFailure` and pre-spawn errors can fire before the
    // publicUrl is observed — the secrets array will contain null
    // entries. The helper must silently ignore those and still scrub
    // whatever real values are present.
    const out = sanitizeError("body=https://x.trycloudflare.com/sss with sss inside", [
      null,
      undefined,
      "",
      "sss",
      "https://x.trycloudflare.com/sss",
      "https://x.trycloudflare.com"
    ]);
    expect(out).not.toContain("sss");
    expect(out).not.toContain("https://x.trycloudflare.com");
    expect(out).toContain("(secret values redacted)");
  });

  test("refreshAppleNote skips osascript entirely when appleNotes.enabled is false", async () => {
    setupInstanceDir("tunnel-manager-notes-disabled");
    let osascriptCalls = 0;
    const manager = new TunnelManager({
      instance: "tunnel-manager-notes-disabled",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: false, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      spawn: () => scriptedChild(["INF https://gated-notes-1.trycloudflare.com\n"]),
      osascript: async () => {
        osascriptCalls += 1;
        return { stdout: "yes\n", stderr: "", exitCode: 0 };
      }
    });
    await manager.start();
    const snapshot = await manager.refreshAppleNote();
    // No osascript invocation should have happened on either the
    // fire-and-forget refresh (gated at start()) or this explicit call.
    expect(osascriptCalls).toBe(0);
    expect(snapshot.appleNotes.lastSyncedAt).toBeNull();
    await manager.stop();
  });

  test("refreshAppleNote is single-flight under concurrent callers", async () => {
    setupInstanceDir("tunnel-manager-notes-singleflight");
    let inFlight = 0;
    let maxInFlight = 0;
    const manager = new TunnelManager({
      instance: "tunnel-manager-notes-singleflight",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: true, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      spawn: () => scriptedChild(["INF https://singleflight-1.trycloudflare.com\n"]),
      osascript: async (script) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(5);
        inFlight -= 1;
        if (script.includes("name of every account")) {
          return { stdout: "yes\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });
    await manager.start();
    await Promise.all([manager.refreshAppleNote(), manager.refreshAppleNote(), manager.refreshAppleNote()]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    await manager.stop();
  });

  test("Apple Notes is skipped when iCloud lookup reports no", async () => {
    setupInstanceDir("tunnel-manager-no-icloud");
    const manager = makeManager("tunnel-manager-no-icloud", {
      streamChunks: ["INF https://test-vibes-44.trycloudflare.com\n"],
      osascript: async () => ({ stdout: "no\n", stderr: "", exitCode: 0 })
    });
    await manager.start();
    await manager.flushNotes();
    const snapshot = manager.getSnapshot();
    expect(snapshot.appleNotes.available).toBe(false);
    expect(snapshot.appleNotes.lastSyncedAt).toBeNull();
    await manager.stop();
  });

  test("composeAppleNoteBody renders the public URL prominently", () => {
    const body = composeAppleNoteBody({
      enabled: true,
      publicUrl: "https://x.trycloudflare.com/sssss",
      cloudflareUrl: "https://x.trycloudflare.com",
      secret: "sssss",
      targetUrl: "http://127.0.0.1:7778",
      observedAt: "2026-01-01T00:00:00.000Z",
      appleNotes: {
        enabled: true,
        folder: "gini",
        noteName: "n",
        available: true,
        lastSyncedAt: null,
        lastError: null
      },
      lastError: null
    });
    expect(body.split("\n")[0]).toBe("https://x.trycloudflare.com/sssss");
    expect(body).toContain("Target: http://127.0.0.1:7778");
  });

  test("unexpected cloudflared exit clears the handle so start() can respawn", async () => {
    setupInstanceDir("tunnel-manager-respawn");
    let spawnCount = 0;
    const exitResolvers: Array<{ resolve: (code: number) => void }> = [];
    const manager = new TunnelManager({
      instance: "tunnel-manager-respawn",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: false, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      disableAppleNotes: true,
      spawn: () => {
        spawnCount += 1;
        const resolvers = Promise.withResolvers<number>();
        exitResolvers.push({ resolve: resolvers.resolve });
        const child = scriptedChild([`INF https://respawn-${spawnCount}.trycloudflare.com\n`]);
        // Override exited so the test controls when the child "dies".
        return { ...child, exited: resolvers.promise };
      }
    });
    await manager.start();
    expect(manager.getSnapshot().publicUrl).toContain("respawn-1");
    // Simulate an unexpected exit. The monitor should clear `this.handle`.
    exitResolvers[0]!.resolve(137);
    await Bun.sleep(5);
    expect(manager.getSnapshot().publicUrl).toBeNull();
    // A fresh start() should now spawn a replacement, not short-circuit.
    await manager.start();
    expect(spawnCount).toBe(2);
    expect(manager.getSnapshot().publicUrl).toContain("respawn-2");
    // Pre-resolve the second exit so stop() doesn't have to wait its 5s
    // SIGKILL grace timer; the test child intentionally overrides
    // `exited` so the manager's stop flow needs our help to settle.
    exitResolvers[1]!.resolve(0);
    await manager.stop();
  });

  test("notesRefresh latch clears after start()-time fire-and-forget", async () => {
    setupInstanceDir("tunnel-manager-latch");
    const manager = new TunnelManager({
      instance: "tunnel-manager-latch",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: true, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      spawn: () => scriptedChild(["INF https://latch-1.trycloudflare.com\n"]),
      osascript: async (script) => {
        if (script.includes("name of every account")) {
          return { stdout: "yes\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });
    await manager.start();
    await manager.flushNotes();
    // After flush the inner refresh has settled. The latch must be cleared
    // — otherwise a subsequent explicit refresh would short-circuit on
    // the stale resolved promise and never run a fresh write.
    const second = manager.refreshAppleNote();
    const third = manager.refreshAppleNote();
    // Both must dedup onto a fresh single-flight, not the stale one.
    expect(await second).toBe(await third);
    expect((await second).appleNotes.lastSyncedAt).not.toBeNull();
    await manager.stop();
  });

  test("refreshAppleNote after a disable-triggered abort schedules a fresh write", async () => {
    setupInstanceDir("tunnel-manager-notes-abort-rescheduling");
    // Track how many distinct osascript pipelines actually invoke the
    // write phase. Without the fresh-schedule guard, a re-enable that
    // races the aborted refresh piggybacks on the aborted promise and
    // the write never runs against the new config.
    let writePhaseCalls = 0;
    // Per-refresh probe gates. Each refreshAppleNote() pulls the next
    // gate from this queue; the test feeds gates so it can control
    // when each refresh's probe completes (and thus when the outer
    // refreshAppleNote await clears the notesRefresh latch).
    type Releaser = (mode: "ok" | "abort") => void;
    const probeGates: Array<{ promise: Promise<"ok" | "abort">; release: Releaser }> = [];
    const enqueueGate = (): Releaser => {
      const { promise, resolve } = Promise.withResolvers<"ok" | "abort">();
      probeGates.push({ promise, release: resolve });
      return resolve;
    };
    const manager = new TunnelManager({
      instance: "tunnel-manager-notes-abort-rescheduling",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: true, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      spawn: () => scriptedChild(["INF https://abort-resched-1.trycloudflare.com\n"]),
      osascript: async (script, options) => {
        if (script.includes("name of every account")) {
          // Pop the next queued gate. If none queued, the probe
          // resolves immediately (used for refreshes the test doesn't
          // need to interleave with).
          const gate = probeGates.shift();
          if (gate) {
            const abortPromise = new Promise<"abort">((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve("abort"), { once: true });
            });
            const mode = await Promise.race([gate.promise, abortPromise]);
            if (mode === "abort" || options?.signal?.aborted) {
              return { stdout: "", stderr: "aborted", exitCode: 137 };
            }
          }
          return { stdout: "yes\n", stderr: "", exitCode: 0 };
        }
        // The write-phase script (set body of note) — count it so the
        // test can assert a fresh refresh actually ran.
        writePhaseCalls += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });
    // Gate the start()-time fire-and-forget refresh so we don't race
    // it against the test's own refresh calls below.
    const startReleaser = enqueueGate();
    await manager.start();
    startReleaser("ok");
    await manager.flushNotes();
    expect(writePhaseCalls).toBe(1);
    // Queue a gate for the refresh that will be aborted. Do NOT release
    // it — the disable's abort signal is what unblocks the probe.
    enqueueGate();
    const aborted = manager.refreshAppleNote();
    // Yield so refreshAppleNoteInner enters the probe and registers
    // its abort listener before we trigger the disable.
    await Bun.sleep(0);
    // Disable WITHOUT awaiting the aborted refresh. This pins the bug:
    // notesRefresh is still set to the aborted promise (it hasn't yet
    // unwound through its finally), and the upcoming re-enable +
    // refreshAppleNote() call must NOT return that stale promise.
    manager.updateConfig({ appleNotes: { enabled: false, folder: "g", noteName: "n", account: "iCloud" } });
    // Re-enable IMMEDIATELY (in the same task) so the test never gives
    // the aborted refresh a chance to clear notesRefresh via its
    // finally. With the bug, refreshAppleNote() sees a non-null
    // notesRefresh and short-circuits, returning the aborted promise.
    manager.updateConfig({ appleNotes: { enabled: true, folder: "g", noteName: "n", account: "iCloud" } });
    const reEnabled = manager.refreshAppleNote();
    // Now release everything: the aborted refresh finishes with no
    // write (because !enabled was true during its inner re-check), and
    // the re-enabled refresh runs the write phase against the freshly
    // restored config.
    await aborted;
    const reEnabledSnapshot = await reEnabled;
    // With the fix: aborted promise was bypassed; a fresh refresh
    // ran and called the write phase. Without the fix:
    // refreshAppleNote() returned the aborted promise and no second
    // write fired.
    expect(writePhaseCalls).toBe(2);
    expect(reEnabledSnapshot.appleNotes.lastSyncedAt).not.toBeNull();
    await manager.stop();
  });

  test("renderSnapshotQr returns null when there is no public URL", () => {
    const out = renderSnapshotQr({
      enabled: true,
      publicUrl: null,
      cloudflareUrl: null,
      secret: "x",
      targetUrl: "http://127.0.0.1:1",
      observedAt: null,
      appleNotes: {
        enabled: false,
        folder: "",
        noteName: "",
        available: null,
        lastSyncedAt: null,
        lastError: null
      },
      lastError: null
    });
    expect(out).toBeNull();
  });

  test("concurrent start() calls dedup onto a single spawn", async () => {
    setupInstanceDir("tunnel-manager-dedup");
    let spawnCount = 0;
    const manager = new TunnelManager({
      instance: "tunnel-manager-dedup",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: false, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      disableAppleNotes: true,
      spawn: () => {
        spawnCount += 1;
        return scriptedChild(["INF https://dedup-tunnel-1.trycloudflare.com\n"]);
      }
    });
    const [a, b] = await Promise.all([manager.start(), manager.start()]);
    expect(spawnCount).toBe(1);
    expect(a.cloudflareUrl).toBe("https://dedup-tunnel-1.trycloudflare.com");
    expect(b.cloudflareUrl).toBe("https://dedup-tunnel-1.trycloudflare.com");
    await manager.stop();
  });

  test("start() during in-flight stop waits for teardown before spawning", async () => {
    setupInstanceDir("tunnel-manager-start-during-stop");
    let spawnCount = 0;
    const spawned: Array<{ killed: boolean }> = [];
    const manager = new TunnelManager({
      instance: "tunnel-manager-start-during-stop",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: false, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      disableAppleNotes: true,
      spawn: () => {
        const state = { killed: false };
        spawned.push(state);
        const url = `INF https://restart-${++spawnCount}.trycloudflare.com\n`;
        return scriptedChild([url], {
          killDelayMs: 30,
          onKill: () => { state.killed = true; }
        });
      }
    });
    await manager.start();
    const stopP = manager.stop();
    const startP = manager.start();
    await Promise.all([stopP, startP]);
    // First child stopped completely before the second spawn began.
    expect(spawned[0]?.killed).toBe(true);
    expect(spawnCount).toBe(2);
    expect(manager.getSnapshot().publicUrl).toContain("restart-2");
    await manager.stop();
  });

  test("stop() during in-flight start aborts the spawn and kills the child", async () => {
    setupInstanceDir("tunnel-manager-stop-during-start");
    let killed = false;
    const manager = new TunnelManager({
      instance: "tunnel-manager-stop-during-start",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: false, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      disableAppleNotes: true,
      spawn: () => {
        const child = scriptedChild(["INF https://laggard-tunnel-9.trycloudflare.com\n"], {
          urlDelayMs: 200,
          onKill: () => { killed = true; }
        });
        return child;
      }
    });
    const startP = manager.start();
    // Issue stop while spawn is mid-flight. The AbortSignal threaded
    // through spawnQuickTunnel rejects the URL race promptly so the
    // gateway's shutdown drain budget (5s) catches the teardown.
    await manager.stop();
    await expect(startP).rejects.toThrow(/aborted/);
    expect(killed).toBe(true);
    // Snapshot must reflect the cancellation, not a stale URL.
    expect(manager.getSnapshot().publicUrl).toBeNull();
  });

  test("start() after a stop()-during-spawn rebuilds spawnAbort and succeeds", async () => {
    // Pins the rapid-fire enable → disable-mid-spawn → enable sequence
    // applyConfig's fire-and-forget disable.preempt.stop() depends on.
    // The PATCH-disable path aborts an in-flight cloudflared spawn to
    // close the 25s residual-damage window where the URL could be
    // advertised after the operator clicked "off"; a subsequent enable
    // PATCH then queues a fresh start(). If startInner did not allocate
    // a brand-new AbortController on each call, the second start would
    // observe the already-aborted signal from the first stop and
    // immediately reject, leaving the operator unable to re-enable the
    // tunnel without a runtime restart. The check here is that the
    // second start spawns a new cloudflared and lands the URL on the
    // snapshot — i.e. the abort state was not carried forward.
    setupInstanceDir("tunnel-manager-restart-after-abort");
    let spawnCount = 0;
    const manager = new TunnelManager({
      instance: "tunnel-manager-restart-after-abort",
      config: {
        enabled: true,
        secret: "abcd1234efgh5678ijkl9012mnop3456",
        appleNotes: { enabled: false, folder: "g", noteName: "n", account: "iCloud" }
      },
      targetUrl: "http://127.0.0.1:7778",
      disableAppleNotes: true,
      spawn: () => {
        spawnCount += 1;
        // First spawn lags so stop() catches it mid-flight; subsequent
        // spawns resolve immediately so the test doesn't race the
        // ambient deadline.
        const urlDelayMs = spawnCount === 1 ? 200 : 0;
        return scriptedChild(
          [`INF https://restart-after-abort-${spawnCount}.trycloudflare.com\n`],
          { urlDelayMs }
        );
      }
    });
    const firstStart = manager.start();
    await manager.stop();
    await expect(firstStart).rejects.toThrow(/aborted/);
    // Re-enable. A stale aborted spawnAbort would surface immediately
    // through spawnQuickTunnel's abortPromise race, rejecting before
    // the URL could ever land on the snapshot.
    const secondSnapshot = await manager.start();
    expect(spawnCount).toBe(2);
    expect(secondSnapshot.cloudflareUrl).toBe(
      "https://restart-after-abort-2.trycloudflare.com"
    );
    expect(secondSnapshot.publicUrl).toContain("restart-after-abort-2");
    await manager.stop();
  });

  test("renderSnapshotQr returns ANSI + SVG when a URL is set", () => {
    const out = renderSnapshotQr({
      enabled: true,
      publicUrl: "https://x.trycloudflare.com/abcd1234efgh5678",
      cloudflareUrl: "https://x.trycloudflare.com",
      secret: "abcd1234efgh5678",
      targetUrl: "http://127.0.0.1:7778",
      observedAt: "2026-01-01",
      appleNotes: {
        enabled: false,
        folder: "",
        noteName: "",
        available: null,
        lastSyncedAt: null,
        lastError: null
      },
      lastError: null
    });
    expect(out?.svg.startsWith("<svg")).toBe(true);
    expect(out?.ansi.length).toBeGreaterThan(50);
    expect(out?.url).toBe("https://x.trycloudflare.com/abcd1234efgh5678");
  });
});

function baseConfig(): RuntimeConfig {
  return {
    instance: "tunnel-test",
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: join(stateRootDir, "instances/tunnel-test"),
    logRoot: join(logRootDir, "tunnel-test"),
    approvalMode: "auto"
  };
}

function setupInstanceDir(instance: string): void {
  process.env.GINI_STATE_ROOT = stateRootDir;
  process.env.GINI_LOG_ROOT = logRootDir;
  rmSync(join(stateRootDir, "instances", instance), { recursive: true, force: true });
  // Clean the log dir too. Historical runtime.jsonl entries from earlier
  // runs would otherwise be visible to credential-leak regression
  // assertions and confuse "is this a fresh write or stale residue?".
  rmSync(join(logRootDir, instance), { recursive: true, force: true });
}

interface ScriptedSpawnOptions {
  streamChunks: string[];
  osascript?: TunnelManagerOptions["osascript"];
  disableAppleNotes?: boolean;
}

function makeManager(instance: string, options: ScriptedSpawnOptions): TunnelManager {
  return new TunnelManager({
    instance,
    config: {
      enabled: true,
      secret: "abcd1234efgh5678ijkl9012mnop3456",
      appleNotes: {
        enabled: true,
        folder: "gini-test",
        noteName: "tunnel-url",
        account: "iCloud"
      }
    },
    targetUrl: "http://127.0.0.1:7778",
    disableAppleNotes: options.disableAppleNotes ?? !options.osascript,
    spawn: () => scriptedChild(options.streamChunks),
    osascript: options.osascript
  });
}

function scriptedChild(
  chunks: string[],
  options: { urlDelayMs?: number; killDelayMs?: number; onKill?: () => void } = {}
) {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const exitResolvers = Promise.withResolvers<number>();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      void (async () => {
        if (options.urlDelayMs) await Bun.sleep(options.urlDelayMs);
        for (const chunk of chunks) {
          if (!controllerRef) return;
          controller.enqueue(encoder.encode(chunk));
        }
      })();
    },
    cancel() {
      controllerRef = null;
    }
  });
  return {
    stderr: stream,
    exited: exitResolvers.promise,
    pid: 99999,
    kill() {
      try { controllerRef?.close(); } catch { /* ignore */ }
      controllerRef = null;
      options.onKill?.();
      if (options.killDelayMs) {
        setTimeout(() => exitResolvers.resolve(0), options.killDelayMs);
      } else {
        exitResolvers.resolve(0);
      }
    }
  };
}
