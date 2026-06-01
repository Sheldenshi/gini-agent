// Pins the disable()-clears-lastWebPort invariant: after a successful
// disable transition, the cached `lastWebPort` must be null. The
// rotate-secret recycle gates its swap on `cloudflared !== null &&
// lastWebPort !== null` today, so the live invariant is already safe
// via the null-cloudflared half of the gate. Clearing lastWebPort
// keeps the invariant local: a future change that drops the
// cloudflared-null half should not have to read a brittle assumption
// from a sibling enable() about whether the cached port survives.

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeMemoryDb } from "../../state/memory-db";
// Capture the real `buildWriteNoteScript` BEFORE the mock below replaces
// the apple-notes module's export map. Bun's module mocks persist
// across test files, so a sibling test file that imports
// `buildWriteNoteScript` directly would otherwise resolve to the mock
// and fail to parse. Delegating to the real implementation inside the
// mock keeps the public surface intact.
import { buildWriteNoteScript as realBuildWriteNoteScript } from "./apple-notes";
// Snapshot the REAL cloudflared-install export VALUES at module-eval
// time, before any mock rebinds the live namespace. A snapshot taken
// inside the test body via `await import(...)` is too late once a
// sibling test file has registered its own mock.module for this path.
// Restoring this snapshot in afterEach undoes our ensureCloudflaredBin
// override so it can't leak into cloudflared-install.test.ts
// (mock.restore() does not unregister mock.module factories).
import * as cloudflaredInstall from "./cloudflared-install";
const realCfInstall = { ...cloudflaredInstall };

const INSTANCE = "manager-disable-clears-lastwebport-test";

describe("disable() clears lastWebPort", () => {
  let tmp: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gini-manager-disable-clears-lastwebport-"));
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = tmp;
    const instanceDir = join(tmp, "instances", INSTANCE);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(
      join(instanceDir, "config.json"),
      JSON.stringify({
        tunnel: {
          enabled: true,
          secret: "T".repeat(32),
          appleNotes: { enabled: false }
        }
      }),
      "utf8"
    );
  });

  afterEach(() => {
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    removeMemoryDb(INSTANCE);
    rmSync(tmp, { recursive: true, force: true });
    mock.restore();
    // mock.restore() leaves mock.module factories registered, so re-register
    // the pristine cloudflared-install snapshot to undo our override before
    // the next test file in this process runs.
    mock.module("./cloudflared-install", () => ({ ...realCfInstall }));
  });

  test("enable then disable: lastWebPort returns to null", async () => {
    mock.module("../health-probe", () => ({
      isSupervisedWebChild: async () => true
    }));
    mock.module("./apple-notes", () => ({
      probeNotesAvailable: async () => ({ available: true }),
      writeNote: async () => {},
      clearNote: async () => {},
      // Preserve the real `buildWriteNoteScript` export so a sibling
      // test file that imports it directly still resolves a callable.
      buildWriteNoteScript: realBuildWriteNoteScript
    }));
    mock.module("./cloudflared", () => ({
      launchCloudflared: () => ({
        process: {
          once: (_event: string, _cb: (...args: unknown[]) => void) => {},
          exitCode: null,
          signalCode: null
        },
        publicUrl: Promise.resolve("https://fake-test.trycloudflare.com"),
        stop: async () => {}
      })
    }));

    // Override only ensureCloudflaredBin to skip real PATH/download
    // resolution; ...realCfInstall keeps every other export real. The
    // afterEach restore re-registers the pristine snapshot so this
    // override can't leak into cloudflared-install.test.ts.
    mock.module("./cloudflared-install", () => ({
      ...realCfInstall,
      ensureCloudflaredBin: async () => "cloudflared"
    }));
    const { __resetTunnelManagerForTests, tunnelManager } = await import("./manager");
    __resetTunnelManagerForTests();
    const mgr = tunnelManager({
      instance: INSTANCE,
      port: 7337,
      token: "test-token",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: join(tmp, "instances", INSTANCE),
      logRoot: join(tmp, "logs", INSTANCE)
    });

    // Enable caches the web port the caller passed in so a later
    // rotateSecret recycle can re-launch cloudflared without the
    // caller threading the port back through.
    const enabled = await mgr.enable(7338);
    expect(enabled.ok).toBe(true);
    expect(mgr.__getLastWebPortForTest()).toBe(7338);

    // Disable must drop the cached value so the rotate-gate invariant
    // — currently `cloudflared !== null && lastWebPort !== null` —
    // stays local. The disable code path also nulls cloudflared, so a
    // rotate today would already short-circuit. Clearing lastWebPort
    // means a future code change that loosens the cloudflared half of
    // the gate can't accidentally consume the stale port.
    const disabled = await mgr.disable();
    expect(disabled.ok).toBe(true);
    expect(mgr.__getLastWebPortForTest()).toBe(null);

    __resetTunnelManagerForTests();
  });
});
