// Pins the runClearNotes recovery-refresh gate: when clearNote returns
// and the mirror is observed enabled, the recovery refresh must only
// fire when `this.generation` still matches the generation captured at
// scheduling time. A concurrent setAppleNotesEnabled toggle that bumps
// the generation has already (or will) schedule its own follow-up
// refresh under the new generation, so the legacy clear's recovery
// would be a duplicate writeNote. Without the gate, a slow clearNote
// that wakes up after multiple toggles fires a redundant refresh for
// every on-state it observes, breaking the "at most one writeNote per
// logical on-state" invariant.
//
// The test runs an enable() under appleNotes:off (so no startup
// refresh), then a single off→on cycle while clearNote is suspended.
// The on-toggle bumps the generation past the off-toggle's captured
// `scheduledGeneration`, so once we release clearNote the recovery
// gate fires the gen-mismatch and no extra writeNote runs. The total
// writeNote count is exactly one — the on-toggle's own scheduled
// refresh.

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeMemoryDb } from "../../state/memory-db";
// Capture the real `buildWriteNoteScript` BEFORE the mock below replaces
// the module's export map. Bun's module mocks persist across test files,
// so a sibling test file that imports `buildWriteNoteScript` directly
// would otherwise resolve to the test's mock and fail at parse time.
// Delegating to the real implementation inside the mock keeps the
// public surface intact for any later importer.
import { buildWriteNoteScript as realBuildWriteNoteScript } from "./apple-notes";

const INSTANCE = "manager-clearnotes-recovery-gate-test";

describe("runClearNotes recovery refresh is gated by generation match", () => {
  let tmp: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gini-manager-clearnotes-recovery-"));
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = tmp;
    const instanceDir = join(tmp, "instances", INSTANCE);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(
      join(instanceDir, "config.json"),
      JSON.stringify({
        tunnel: {
          // Start with the mirror OFF so enable() does not schedule its
          // own startup refresh — the test is about the off→on toggle
          // path, not the enable-time refresh. The first off→on toggle
          // schedules the only legitimate writeNote we expect to count.
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
  });

  test("a slow clearNote followed by off→on toggles fires writeNote exactly once per on-state", async () => {
    // clearNote suspends until the test explicitly releases it. This
    // models the 15s osascript window during which the operator can
    // race the clear with multiple toggles.
    let releaseClearNote: () => void = () => {};
    const clearNotePromise = new Promise<void>((resolve) => {
      releaseClearNote = resolve;
    });
    const clearNoteCalls = { count: 0 };
    const writeNoteCalls = { count: 0 };

    mock.module("./apple-notes", () => ({
      probeNotesAvailable: async () => ({ available: true }),
      writeNote: async () => {
        writeNoteCalls.count += 1;
      },
      clearNote: async () => {
        clearNoteCalls.count += 1;
        await clearNotePromise;
      },
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
    mock.module("../health-probe", () => ({
      isSupervisedWebChild: async () => true
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

    // The enable() seed has appleNotes:false, so no notes refresh fires
    // from inside enable(). After this awaits, the tunnel is live, the
    // notes mirror is off, and no writeNote has run yet.
    const enabled = await mgr.enable(7338);
    expect(enabled.ok).toBe(true);
    // Let the constructor probe settle (sets notesAvailable=true) so
    // the off-toggle's runClearNotes branch fires.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(writeNoteCalls.count).toBe(0);

    // First on-toggle schedules a runRefreshNotes which writes once.
    const on1 = await mgr.setAppleNotesEnabled(true);
    expect(on1.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(writeNoteCalls.count).toBe(1);

    // Off-toggle schedules runClearNotes — clearNote suspends.
    const off1 = await mgr.setAppleNotesEnabled(false);
    expect(off1.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(clearNoteCalls.count).toBe(1);

    // Second on-toggle bumps generation past the suspended clear's
    // scheduledGeneration AND schedules its own refresh (the second
    // legitimate writeNote).
    const on2 = await mgr.setAppleNotesEnabled(true);
    expect(on2.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(writeNoteCalls.count).toBe(2);

    // Release the suspended clearNote. The post-clear branch sees
    // `appleNotes.enabled === true` (the second on-toggle re-enabled
    // the mirror) but its captured `scheduledGeneration` is from the
    // off-toggle, which is now stale. With the recovery gate, it
    // refuses to schedule a refresh; without the gate, it would fire
    // a third writeNote.
    releaseClearNote();
    // Drain twice: any fire-and-forget runRefreshNotes scheduled by
    // the clear's recovery branch (without the gate) would only land
    // after a second microtask turn behind the awaited
    // probeNotesAvailable inside the worker.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The clear's recovery refresh did NOT fire. Total writeNote
    // count stays at two — one per logical on-state.
    expect(writeNoteCalls.count).toBe(2);

    __resetTunnelManagerForTests();
  });
});
