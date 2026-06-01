// Pins the rotateSecret() success-clears-error contract: a successful
// rotation must wipe any prior `lastError` / `lastErrorCode` from the
// snapshot regardless of whether cloudflared is currently running.
// The disabled-instance branch (`this.cloudflared === null`) returns
// directly from the pre-stamp without any further snapshot update, so
// without the explicit clear a stale error from a prior failed enable
// would survive the rotation and the settings card would still show
// the operator-actionable error code even though the underlying state
// is now a freshly-rotated secret.

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeMemoryDb } from "../../state/memory-db";

const INSTANCE = "manager-rotate-clears-error-test";

describe("rotateSecret success clears prior lastError state", () => {
  let tmp: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gini-manager-rotate-clears-error-"));
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = tmp;
    const instanceDir = join(tmp, "instances", INSTANCE);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(
      join(instanceDir, "config.json"),
      JSON.stringify({
        tunnel: {
          enabled: false,
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
  });

  test("rotateSecret on a disabled (cloudflared===null) instance clears lastError + lastErrorCode", async () => {
    // The probe returns false on the first call so a probe-driven
    // enable() failure stamps `lastErrorCode: "web_port_unhealthy"`
    // on the snapshot before the rotation runs. `appleNotes.enabled`
    // is false in the seed config, so the real probeNotesAvailable
    // resolves harmlessly and we don't mock the apple-notes module —
    // mocking it from this file would leak a stub `buildWriteNoteScript`
    // into apple-notes.test.ts because bun's module mocks persist
    // across test files.
    mock.module("../health-probe", () => ({
      isSupervisedWebChild: async () => false
    }));
    mock.module("./cloudflared", () => ({
      launchCloudflared: () => {
        throw new Error("launchCloudflared should not be reached when probe fails");
      }
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

    // Step 1: stamp lastError + lastErrorCode via a failed enable. The
    // unhealthy probe sets `lastErrorCode: "web_port_unhealthy"` and
    // leaves the snapshot in the disabled-with-error state — same shape
    // an operator would see after a real probe failure.
    const failed = await mgr.enable(7338);
    expect(failed.ok).toBe(false);
    const afterFail = mgr.current();
    expect(afterFail.lastErrorCode).toBe("web_port_unhealthy");
    expect(afterFail.lastError).not.toBe(null);
    expect(afterFail.enabled).toBe(false);

    // Step 2: rotate. cloudflared is null (enable rolled back), so the
    // rotateSecret path skips the recycle branch entirely and returns
    // the pre-stamp snapshot directly. The pre-stamp must clear both
    // error fields.
    const rotated = await mgr.rotateSecret();
    expect(rotated.ok).toBe(true);
    if (rotated.ok) {
      expect(rotated.snapshot.lastError).toBe(null);
      expect(rotated.snapshot.lastErrorCode).toBe(null);
    }
    // The live snapshot reflects the same clear.
    const afterRotate = mgr.current();
    expect(afterRotate.lastError).toBe(null);
    expect(afterRotate.lastErrorCode).toBe(null);
    // Sanity: the rotation actually happened — the in-memory secret
    // moved off the seed value.
    expect(afterRotate.secret).not.toBe("T".repeat(32));

    __resetTunnelManagerForTests();
  });
});
