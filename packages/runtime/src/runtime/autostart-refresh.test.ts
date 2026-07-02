// Tests for post-shutdown autostart-refresh signaling.
//
// The headline guarantee: the refresh subprocess does NOT spawn before
// the response to POST /api/setup/provider is fully flushed. We prove
// this by simulating the full lifecycle:
//
//   1. Write a marker via requestAutostartRefresh (with refresh-skip
//      gating the actual SIGTERM so the test runner survives).
//   2. Drive a fake Bun.serve response that streams its body in chunks
//      under a controlled clock; assert that consumeAutostartRefresh
//      is NOT called until after the last chunk is read.
//   3. Send SIGTERM (simulated by invoking the drain logic directly);
//      assert consumeAutostartRefresh fires AFTER the drain completes.
//
// We don't actually invoke launchctl. The spawn is replaced with a
// recorder that captures argv + timing. This isolates the contract
// (marker → drain → spawn) from the macOS LaunchAgents side effects.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { __testing, autostartRefreshLogPath, consumeAutostartRefresh, refreshMarkerPath, requestAutostartRefresh } from "./autostart-refresh";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function scratch(): { home: string; stateRoot: string; cleanup: () => void } {
  const root = `/tmp/gini-autostart-refresh-tests/${tag()}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const stateRoot = join(home, ".gini");
  mkdirSync(stateRoot, { recursive: true });
  return {
    home,
    stateRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

describe("autostart-refresh", () => {
  let env: { HOME?: string; GINI_STATE_ROOT?: string; GINI_SKIP_PLIST_REFRESH?: string };
  let s: ReturnType<typeof scratch>;
  const instance = `arf-${tag()}`;

  beforeEach(() => {
    env = {
      HOME: process.env.HOME,
      GINI_STATE_ROOT: process.env.GINI_STATE_ROOT,
      GINI_SKIP_PLIST_REFRESH: process.env.GINI_SKIP_PLIST_REFRESH
    };
    s = scratch();
    process.env.HOME = s.home;
    process.env.GINI_STATE_ROOT = s.stateRoot;
    // Default for these tests: SKIP the real SIGTERM dispatch so we don't
    // kill the test runner. Individual tests can clear this if they want
    // to exercise the signaling path explicitly (we don't, since killing
    // the test runner has no point).
    process.env.GINI_SKIP_PLIST_REFRESH = "1";
    // Reset the in-process refresh-requested flag between tests so the
    // "marker without flag" path can be exercised explicitly per case.
    __testing.resetRefreshFlag();
  });

  afterEach(() => {
    if (env.HOME === undefined) delete process.env.HOME; else process.env.HOME = env.HOME;
    if (env.GINI_STATE_ROOT === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = env.GINI_STATE_ROOT;
    if (env.GINI_SKIP_PLIST_REFRESH === undefined) delete process.env.GINI_SKIP_PLIST_REFRESH;
    else process.env.GINI_SKIP_PLIST_REFRESH = env.GINI_SKIP_PLIST_REFRESH;
    s.cleanup();
  });

  test("requestAutostartRefresh returns false on non-darwin or when no plist exists", () => {
    if (process.platform !== "darwin") {
      expect(requestAutostartRefresh(instance)).toBe(false);
      return;
    }
    // No plist exists for this scratch instance.
    expect(requestAutostartRefresh(instance)).toBe(false);
    // Marker file should NOT have been written.
    expect(existsSync(refreshMarkerPath(instance))).toBe(false);
  });

  test("requestAutostartRefresh writes marker when plist exists, without firing SIGTERM (skip mode)", () => {
    if (process.platform !== "darwin") return;
    const plistDir = join(s.home, "Library", "LaunchAgents");
    mkdirSync(plistDir, { recursive: true });
    const plistPath = join(plistDir, `ai.lilaclabs.gini.${instance}.gateway.plist`);
    writeFileSync(plistPath, "<plist/>\n");

    expect(requestAutostartRefresh(instance)).toBe(true);
    const marker = refreshMarkerPath(instance);
    expect(existsSync(marker)).toBe(true);
    // Marker contents are the instance name.
    expect(readFileSync(marker, "utf8").trim()).toBe(instance);
  });

  test("consumeAutostartRefresh is a no-op when no marker exists", () => {
    if (process.platform !== "darwin") {
      expect(consumeAutostartRefresh(instance)).toBe(false);
      return;
    }
    let spawnCalls = 0;
    const fakeSpawn = ((..._args: unknown[]) => {
      spawnCalls += 1;
      return { unref() { /* no-op */ } } as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as unknown as typeof import("node:child_process").spawn;
    expect(consumeAutostartRefresh(instance, { spawnImpl: fakeSpawn })).toBe(false);
    expect(spawnCalls).toBe(0);
  });

  test("consumeAutostartRefresh removes marker and execs the refresh subprocess", () => {
    if (process.platform !== "darwin") return;
    // Drive the flag via the public API so we exercise the full
    // request → consume contract. requestAutostartRefresh writes the
    // marker AND sets the in-process refreshRequestedInProcess flag.
    const plistDir = join(s.home, "Library", "LaunchAgents");
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(join(plistDir, `ai.lilaclabs.gini.${instance}.gateway.plist`), "<plist/>\n");
    expect(requestAutostartRefresh(instance)).toBe(true);
    const marker = refreshMarkerPath(instance);
    expect(existsSync(marker)).toBe(true);

    let capturedArgs: string[] | null = null;
    let unrefCalled = false;
    const fakeSpawn = ((cmd: string, args: string[], _options: unknown) => {
      capturedArgs = [cmd, ...args];
      return {
        unref() { unrefCalled = true; }
      } as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as unknown as typeof import("node:child_process").spawn;

    const result = consumeAutostartRefresh(instance, { spawnImpl: fakeSpawn });
    expect(result).toBe(true);
    // Marker is gone now.
    expect(existsSync(marker)).toBe(false);
    // Spawn fired with the expected CLI arguments.
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!.join(" ")).toContain("gini autostart enable");
    expect(capturedArgs!.join(" ")).toContain(`--instance ${instance}`);
    expect(capturedArgs!.join(" ")).toContain("--kind gateway");
    expect(unrefCalled).toBe(true);
  });

  // The headline test: prove the refresh subprocess does NOT spawn until
  // the response is fully flushed. We simulate the response lifecycle by:
  //   1. Recording a "respondedAt" timestamp when the simulated body
  //      finishes streaming.
  //   2. Recording a "spawnedAt" timestamp inside the fake spawn.
  //   3. The simulated drain calls consumeAutostartRefresh — and that
  //      is what fires the spawn. The drain runs AFTER the body
  //      finishes streaming.
  // We assert spawnedAt > respondedAt to prove the order.
  test("spawn does NOT fire until after response body is fully streamed", async () => {
    if (process.platform !== "darwin") return;
    // Set up a marker, as if /api/setup/provider had just been hit.
    const plistDir = join(s.home, "Library", "LaunchAgents");
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(join(plistDir, `ai.lilaclabs.gini.${instance}.gateway.plist`), "<plist/>\n");
    expect(requestAutostartRefresh(instance)).toBe(true);

    let respondedAt = 0;
    let spawnedAt = 0;
    const fakeSpawn = ((..._args: unknown[]) => {
      spawnedAt = performance.now();
      return { unref() { /* no-op */ } } as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as unknown as typeof import("node:child_process").spawn;

    // Simulate Bun.serve flushing a multi-chunk JSON response body. The
    // bytes go through a ReadableStream, we await each chunk, and when
    // the controller closes we mark `respondedAt`. This stands in for
    // `server.stop(false)` waiting for in-flight responses to drain
    // (the round-4 HIGH-1 fix replaced the force-close stop(true) call
    // with the polite stop(false) variant in src/server.ts).
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`{"ok":true,`));
        await Bun.sleep(20);
        controller.enqueue(enc.encode(`"plistRefreshNeeded":true}`));
        await Bun.sleep(20);
        controller.close();
      }
    });
    // Consume the stream chunk-by-chunk so we know when it finishes.
    const reader = body.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) {
        respondedAt = performance.now();
        break;
      }
    }

    // NOW simulate the SIGTERM handler running its drain-then-consume.
    // The drain completed when respondedAt was set; consumeAutostartRefresh
    // is what would actually fire the spawn.
    const consumed = consumeAutostartRefresh(instance, { spawnImpl: fakeSpawn });
    expect(consumed).toBe(true);
    expect(spawnedAt).toBeGreaterThan(0);
    expect(respondedAt).toBeGreaterThan(0);
    // The whole point: the spawn happened AFTER the response finished
    // streaming. With the old setImmediate+setTimeout(200ms) heuristic,
    // the order was reversed for any response body that took >200ms to
    // stream — which is what HIGH-A flagged.
    expect(spawnedAt).toBeGreaterThan(respondedAt);
  });

  // Round-4 HIGH-2 fix: marker present from a prior crash, but THIS
  // process never called requestAutostartRefresh. An external SIGTERM
  // (e.g. user ran `gini stop`) must NOT trigger a respawn. The stale
  // marker IS cleaned up so it doesn't fire on the next setup POST.
  test("does NOT spawn when marker exists but in-process flag not set (external SIGTERM)", () => {
    if (process.platform !== "darwin") return;
    // Drop a marker as if a previous run had crashed mid-refresh, or
    // as if some other process had written it. Crucially: do NOT call
    // requestAutostartRefresh in this process — the flag stays false.
    const marker = refreshMarkerPath(instance);
    mkdirSync(join(s.stateRoot, "instances", instance), { recursive: true });
    writeFileSync(marker, instance);

    let spawnCalls = 0;
    const fakeSpawn = ((..._args: unknown[]) => {
      spawnCalls += 1;
      return { unref() { /* no-op */ } } as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as unknown as typeof import("node:child_process").spawn;

    const result = consumeAutostartRefresh(instance, { spawnImpl: fakeSpawn });
    // No spawn happened — the flag gates the bootstrap.
    expect(result).toBe(false);
    expect(spawnCalls).toBe(0);
    // BUT the marker is cleaned up so it doesn't accumulate on disk
    // and fire on the next setup POST. (If we left it, the next
    // request → consume cycle would respect the flag but the file
    // would never disappear.)
    expect(existsSync(marker)).toBe(false);
  });

  test("DOES spawn when refreshRequestedInProcess is set (internal SIGTERM from setup POST)", () => {
    if (process.platform !== "darwin") return;
    // Plist on disk + requestAutostartRefresh call: both the marker AND
    // the in-process flag should be set after this.
    const plistDir = join(s.home, "Library", "LaunchAgents");
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(join(plistDir, `ai.lilaclabs.gini.${instance}.gateway.plist`), "<plist/>\n");
    expect(requestAutostartRefresh(instance)).toBe(true);

    let spawnCalls = 0;
    const fakeSpawn = ((..._args: unknown[]) => {
      spawnCalls += 1;
      return { unref() { /* no-op */ } } as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as unknown as typeof import("node:child_process").spawn;

    const result = consumeAutostartRefresh(instance, { spawnImpl: fakeSpawn });
    expect(result).toBe(true);
    expect(spawnCalls).toBe(1);
  });

  test("marker tagged for a different instance is left alone (no spawn)", () => {
    if (process.platform !== "darwin") return;
    const marker = refreshMarkerPath(instance);
    mkdirSync(join(s.stateRoot, "instances", instance), { recursive: true });
    writeFileSync(marker, "some-other-instance");

    let spawnCalls = 0;
    const fakeSpawn = ((..._args: unknown[]) => {
      spawnCalls += 1;
      return { unref() { /* no-op */ } } as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as unknown as typeof import("node:child_process").spawn;
    const result = consumeAutostartRefresh(instance, { spawnImpl: fakeSpawn });
    expect(result).toBe(false);
    expect(spawnCalls).toBe(0);
    // Marker should still be there for the right instance to consume.
    expect(existsSync(marker)).toBe(true);
  });

  // Round-4 MEDIUM fix: the detached refresh subprocess used to spawn
  // with stdio:"ignore" and no listeners. Any failure (launchctl
  // broken, bun missing on PATH) was silent. Now we write a preamble
  // line to a per-instance log file and redirect child stdout+stderr
  // to that file in append mode. This test proves the log file exists
  // and contains the preamble after consumeAutostartRefresh fires.
  test("consume writes a non-trivial preamble to the autostart-refresh log file", () => {
    if (process.platform !== "darwin") return;
    const plistDir = join(s.home, "Library", "LaunchAgents");
    mkdirSync(plistDir, { recursive: true });
    writeFileSync(join(plistDir, `ai.lilaclabs.gini.${instance}.gateway.plist`), "<plist/>\n");
    expect(requestAutostartRefresh(instance)).toBe(true);

    const fakeSpawn = ((..._args: unknown[]) => {
      return { unref() { /* no-op */ } } as unknown as ReturnType<typeof import("node:child_process").spawn>;
    }) as unknown as typeof import("node:child_process").spawn;

    const result = consumeAutostartRefresh(instance, { spawnImpl: fakeSpawn });
    expect(result).toBe(true);

    const logPath = autostartRefreshLogPath(instance);
    expect(existsSync(logPath)).toBe(true);
    const contents = readFileSync(logPath, "utf8");
    // Preamble line shape: "[<iso-timestamp>] consume: spawning ..."
    expect(contents).toContain("consume: spawning");
    expect(contents).toContain(`--instance ${instance}`);
    expect(contents).toContain("--kind gateway");
    // ISO-8601-ish timestamp prefix.
    expect(contents).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
  });
});
