// Tests for the startup launchd-plist reconcile.
//
// The reconcile fingerprints the plist the current code would generate and
// compares it to the stamp baked into the on-disk plist. We exercise the
// four contract branches with an injected spawn recorder (so nothing real
// launches) and a scratch HOME/state/log root (so plist writes and log files
// land in a throwaway dir, never the developer's ~/Library/LaunchAgents):
//
//   - no managed plist on disk      → no-op (no spawn)
//   - all stamps match              → no-op (spawn recorder not called)
//   - a missing/mismatched stamp    → spawns enable once, leaving the on-disk
//                                      plist UNTOUCHED (the detached enable owns
//                                      the regenerate+reload; pre-stamping the
//                                      file would mask drift if the relaunch failed)
//   - a second call in-process      → guarded no-op (once-per-process latch)
//
// macOS only: the gating is `process.platform === "darwin"`, so on other
// platforms the suite is skipped (the reconcile returns immediately there).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  generatePlist,
  plistPathFor,
  readPlistStamp,
  supervisedServices
} from "../cli/autostart";
import { logDir } from "../paths";
import type { RuntimeConfig } from "../types";
import { __testing, reconcileAutostartPlistOnStartup } from "./autostart-reconcile";

function tag(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;
}

function scratch(): { home: string; stateRoot: string; logRoot: string; cleanup: () => void } {
  const root = `/tmp/gini-autostart-reconcile-tests/${tag()}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const home = join(root, "home");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  const stateRoot = join(home, ".gini");
  const logRoot = join(root, "logs");
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(logRoot, { recursive: true });
  return { home, stateRoot, logRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const isDarwin = process.platform === "darwin";

// A recorder standing in for child_process.spawn. Captures argv and returns a
// child-like object with an unref() so the module's `child.unref()` is safe.
function makeSpawnRecorder() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnImpl = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { unref() { /* no-op */ } } as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as unknown as typeof import("node:child_process").spawn;
  return { calls, spawnImpl };
}

// Write all three current plists to disk so their on-disk stamps match what
// the reconcile computes (the "up to date" fixture). Uses the SAME
// supervisedServices resolution the module uses, then generatePlist (which
// bakes the matching stamp).
function writeCurrentPlists(instance: string): void {
  const services = supervisedServices({ instance });
  const logRoot = logDir(instance);
  for (const svc of services) {
    const xml = generatePlist({
      instance,
      kind: svc.kind,
      spec: svc.spec,
      stdoutPath: join(logRoot, svc.stdoutLogFilename),
      stderrPath: join(logRoot, svc.stderrLogFilename),
      ...(svc.startIntervalSeconds !== undefined ? { startIntervalSeconds: svc.startIntervalSeconds } : {})
    });
    writeFileSync(svc.plistPath, xml);
  }
}

(isDarwin ? describe : describe.skip)("reconcileAutostartPlistOnStartup", () => {
  let env: { HOME?: string; GINI_STATE_ROOT?: string; GINI_LOG_ROOT?: string };
  let s: ReturnType<typeof scratch>;
  let instance: string;
  let config: RuntimeConfig;

  beforeEach(() => {
    env = {
      HOME: process.env.HOME,
      GINI_STATE_ROOT: process.env.GINI_STATE_ROOT,
      GINI_LOG_ROOT: process.env.GINI_LOG_ROOT
    };
    s = scratch();
    process.env.HOME = s.home;
    process.env.GINI_STATE_ROOT = s.stateRoot;
    process.env.GINI_LOG_ROOT = s.logRoot;
    instance = `arc-${tag()}`;
    config = { instance } as RuntimeConfig;
    __testing.resetGuard();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    s.cleanup();
  });

  test("no managed gateway plist on disk → no-op (no spawn)", async () => {
    const rec = makeSpawnRecorder();
    const dispatched = await reconcileAutostartPlistOnStartup(config, { spawnImpl: rec.spawnImpl });
    expect(dispatched).toBe(false);
    expect(rec.calls.length).toBe(0);
  });

  test("all stamps match → no-op (spawn recorder not called)", async () => {
    writeCurrentPlists(instance);
    const rec = makeSpawnRecorder();
    const dispatched = await reconcileAutostartPlistOnStartup(config, { spawnImpl: rec.spawnImpl });
    expect(dispatched).toBe(false);
    expect(rec.calls.length).toBe(0);
  });

  test("a drifted (stale-stamp) gateway plist → spawns enable once, leaving the file untouched", async () => {
    writeCurrentPlists(instance);
    // Corrupt the gateway plist's stamp to simulate a stale install: replace
    // the baked stamp value with a bogus one. The reconcile must see drift.
    const gatewayPath = plistPathFor(instance, "gateway");
    const original = readFileSync(gatewayPath, "utf8");
    const corrupted = original.replace(
      /<key>GINI_PLIST_STAMP<\/key>\s*<string>[^<]*<\/string>/,
      "<key>GINI_PLIST_STAMP</key><string>staleaaaaaaa</string>"
    );
    writeFileSync(gatewayPath, corrupted);
    expect(readPlistStamp(gatewayPath)).toBe("staleaaaaaaa");

    const rec = makeSpawnRecorder();
    const dispatched = await reconcileAutostartPlistOnStartup(config, { spawnImpl: rec.spawnImpl });
    expect(dispatched).toBe(true);

    // The reconcile must NOT pre-write/pre-stamp the on-disk plist — that's the
    // detached enable's job. Pre-stamping before the reload happened would mask
    // drift (a matching stamp next boot) if the relaunch failed. So the file
    // still carries the stale stamp; only the real `enable` would rewrite it.
    expect(readPlistStamp(gatewayPath)).toBe("staleaaaaaaa");

    // Exactly one detached `gini autostart enable --instance <instance>`.
    expect(rec.calls.length).toBe(1);
    expect(rec.calls[0]!.cmd).toBe(process.execPath);
    expect(rec.calls[0]!.args).toEqual([
      "run", "gini", "autostart", "enable",
      "--instance", instance
    ]);
  });

  test("a missing-stamp (pre-stamp) plist is treated as drift", async () => {
    // Simulate a plist written before the stamp existed: no GINI_PLIST_STAMP
    // env entry at all. Only the gateway plist needs to exist for the gate.
    const gatewayPath = plistPathFor(instance, "gateway");
    writeFileSync(
      gatewayPath,
      "<plist><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string></dict></dict></plist>"
    );
    expect(readPlistStamp(gatewayPath)).toBeNull();

    const rec = makeSpawnRecorder();
    const dispatched = await reconcileAutostartPlistOnStartup(config, { spawnImpl: rec.spawnImpl });
    expect(dispatched).toBe(true);
    expect(rec.calls.length).toBe(1);
    // The reconcile leaves the on-disk plist untouched (still stamp-less) —
    // the detached enable owns the regenerate+reload, so a failed relaunch
    // keeps the drift detectable for the next gateway start.
    expect(readPlistStamp(gatewayPath)).toBeNull();
  });

  test("second call in the same process is a guarded no-op", async () => {
    const gatewayPath = plistPathFor(instance, "gateway");
    writeFileSync(
      gatewayPath,
      "<plist><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string></dict></dict></plist>"
    );

    const first = makeSpawnRecorder();
    expect(await reconcileAutostartPlistOnStartup(config, { spawnImpl: first.spawnImpl })).toBe(true);
    expect(first.calls.length).toBe(1);

    // Even with the plist still drifted (we don't reset it), the latch
    // prevents a second fire within this process lifetime.
    const second = makeSpawnRecorder();
    expect(await reconcileAutostartPlistOnStartup(config, { spawnImpl: second.spawnImpl })).toBe(false);
    expect(second.calls.length).toBe(0);
  });

  test("writes a per-instance reconcile log preamble on drift", async () => {
    const gatewayPath = plistPathFor(instance, "gateway");
    writeFileSync(
      gatewayPath,
      "<plist><dict><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string></dict></dict></plist>"
    );
    const rec = makeSpawnRecorder();
    await reconcileAutostartPlistOnStartup(config, { spawnImpl: rec.spawnImpl });
    const logPath = join(logDir(instance), "autostart-reconcile.log");
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("autostart enable --instance");
  });
});
