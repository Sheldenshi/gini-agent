// Pins the disable() ordering invariant that closes the push-device
// recheck race: the in-memory snapshot must flip to `enabled:false`
// BEFORE the purge runs and the Notes clear is awaited. Without the
// pre-stamp, a push-device handler that reads
// `tunnelManager(config).current()` during the 15s clearNote osascript
// window would observe `enabled:true`, pass its recheck, and let
// `upsertDevice` insert a fresh `origin:"tunnel"` row AFTER the purge
// has wiped the table — leaving an orphan subscription window.

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeMemoryDb } from "../../state/memory-db";

const INSTANCE = "manager-disable-race-test";

describe("TunnelManager disable() snapshot pre-stamp ordering", () => {
  let tmp: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gini-manager-disable-race-"));
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
          appleNotes: { enabled: true }
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

  test("snapshot.enabled is false while clearNote is awaiting, purge runs exactly once and no row is inserted after it", async () => {
    // Controllable clearNote: do not resolve until we explicitly call
    // resolveClearNote. This lets us pin the recheck observation
    // mid-disable.
    let resolveClearNote: () => void = () => {};
    const clearNoteCalled = { count: 0 };
    const clearNotePromise = new Promise<void>((resolve) => {
      resolveClearNote = resolve;
    });

    mock.module("./apple-notes", () => ({
      probeNotesAvailable: async () => ({ available: true }),
      writeNote: async () => {},
      clearNote: async () => {
        clearNoteCalled.count += 1;
        await clearNotePromise;
      }
    }));

    // Count purgeTunnelDevices invocations: the production sequence
    // must purge exactly once and only AFTER the snapshot pre-stamp.
    const purgeCalls: number[] = [];
    const observed: { snapshotEnabledAtPurge: boolean | null } = { snapshotEnabledAtPurge: null };
    const insertedAfterPurge = { count: 0 };

    // Replace the `state` module so we can observe purge ordering and
    // simulate the push-device handler's behavior: read the live
    // snapshot AFTER purge runs, and only insert a fake row if the
    // recheck passes (i.e. enabled is still true).
    let observeSnapshotEnabled: (() => boolean) | null = null;
    mock.module("../../state", () => ({
      appendLog: () => {},
      purgeTunnelDevices: () => {
        purgeCalls.push(Date.now());
        // Capture the current value of snapshot.enabled at the moment
        // the purge runs so we can verify the pre-stamp landed first.
        observed.snapshotEnabledAtPurge = observeSnapshotEnabled
          ? observeSnapshotEnabled()
          : null;
        return { deleted: 0 };
      }
    }));

    // Block any real cloudflared spawn.
    mock.module("./cloudflared", () => ({
      launchCloudflared: () => {
        throw new Error("launchCloudflared should not be reached in this test");
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

    observeSnapshotEnabled = () => mgr.current().enabled;

    // Force the snapshot to look enabled with a Notes mirror so the
    // clearNote path runs. The constructor probe might mutate
    // appleNotes; reach in to force the shape we need.
    mgr.__setSnapshotForTest({ enabled: true, secret: "T".repeat(32) });
    // Force notesAvailable so the disable() Notes branch fires.
    // notesAvailable is a private field; we approximate by waiting
    // for the constructor's probe to settle. probeNotesAvailable is
    // mocked to return available:true, so the apply chain will set
    // notesAvailable true.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Start disable(). It will run synchronously up to the await
    // clearNote and suspend there.
    const disablePromise = mgr.disable();

    // Yield to let the apply-chain task run up to the clearNote await.
    // The snapshot pre-stamp must already have happened by now.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Simulate the in-flight push-device handler's recheck. The
    // ordering invariant says enabled must already be false here.
    const liveDuringWait = mgr.current();
    // If liveDuringWait.enabled is true, the handler would pass the
    // recheck and upsertDevice would record a tunneled row AFTER the
    // purge. Model that branch.
    if (liveDuringWait.enabled) {
      insertedAfterPurge.count += 1;
    }

    // Release clearNote so disable() finishes.
    resolveClearNote();
    const result = await disablePromise;

    expect(result.ok).toBe(true);
    // Notes clearNote was invoked exactly once.
    expect(clearNoteCalled.count).toBe(1);
    // Purge ran exactly once.
    expect(purgeCalls.length).toBe(1);
    // And it observed the pre-stamped snapshot — enabled was already
    // false at the moment purge fired.
    expect(observed.snapshotEnabledAtPurge).toBe(false);
    // The simulated recheck during the clearNote await saw
    // enabled:false and refused to insert a row.
    expect(insertedAfterPurge.count).toBe(0);
    // Final snapshot is the documented disabled shape.
    expect(mgr.current().enabled).toBe(false);
    expect(mgr.current().publicUrl).toBe(null);

    __resetTunnelManagerForTests();
  });
});
