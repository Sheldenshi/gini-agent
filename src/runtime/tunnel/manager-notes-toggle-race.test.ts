// Pins the setAppleNotesEnabled generation-bump contract: an in-flight
// `runRefreshNotes` scheduled by a prior enable() / rotateSecret() at
// generation gen=X must be SUPERSEDED by a subsequent
// `setAppleNotesEnabled` toggle, so the older worker bails its
// `scheduledGeneration !== this.generation` gate before its osascript
// can write a stale URL/secret to iCloud. Before the bump landed in
// `setAppleNotesEnabled`, the toggle's persist didn't bump generation,
// so the prior refresh kept executing and could fire `writeNote`
// concurrently with the toggle's own refresh.

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeMemoryDb } from "../../state/memory-db";
// Snapshot the REAL cloudflared-install export VALUES at module-eval
// time, before any mock can rebind the live namespace. A snapshot taken
// inside the test body via `await import(...)` is too late: once a
// sibling test file (which Bun loads in the same process) has registered
// its own `mock.module("./cloudflared-install", …)`, that dynamic import
// resolves to the leaked mock, not the original. `mock.restore()` does
// NOT unregister a `mock.module` factory, so the override has to be
// undone explicitly in afterEach (see below) to keep the full public
// surface — CLOUDFLARED_RELEASES_URL, cloudflaredAssetFor,
// findCloudflaredOnPath, the real ensureCloudflaredBin — intact for
// cloudflared-install.test.ts.
import * as cloudflaredInstall from "./cloudflared-install";
const realCfInstall = { ...cloudflaredInstall };

const INSTANCE = "manager-notes-toggle-race-test";

describe("setAppleNotesEnabled bumps generation to supersede the prior worker", () => {
  let tmp: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gini-manager-notes-toggle-"));
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
    // mock.restore() leaves mock.module factories registered, so a
    // ./cloudflared-install override from this file would otherwise
    // persist into the next test file in the same process (e.g.
    // cloudflared-install.test.ts). Re-register the pristine snapshot to
    // hand the real module back.
    mock.module("./cloudflared-install", () => ({ ...realCfInstall }));
  });

  test("an off-toggle bumps generation so a prior in-flight refresh bails before writeNote", async () => {
    // probeNotesAvailable suspends for the FIRST call so the in-flight
    // refresh from enable() can be held mid-execution while the off
    // toggle bumps generation. After the toggle's persist runs, when
    // we release probe, the prior refresh wakes up at its post-probe
    // gen recheck, sees `scheduledGeneration !== this.generation`,
    // and returns "superseded" before writeNote can fire.
    let releaseFirstProbe: () => void = () => {};
    const firstProbePromise = new Promise<void>((resolve) => {
      releaseFirstProbe = resolve;
    });
    const probeCalls: number[] = [];
    const writeNoteCalls: number[] = [];

    // The TunnelManager constructor fires its own probeNotesAvailable
    // inside the apply chain — that one must resolve immediately so
    // the queue isn't blocked. The SECOND probe call (the one inside
    // `runRefreshNotes` scheduled by enable()) is the one we suspend
    // so the prior refresh can be held mid-execution while the off
    // toggle bumps generation.
    mock.module("./apple-notes", () => ({
      probeNotesAvailable: async () => {
        probeCalls.push(probeCalls.length + 1);
        if (probeCalls.length === 2) {
          await firstProbePromise;
        }
        return { available: true };
      },
      writeNote: async () => {
        writeNoteCalls.push(writeNoteCalls.length + 1);
      },
      clearNote: async () => {
        // No-op: this test focuses on the prior-refresh supersede, not
        // the clearNote ordering. clearNote can resolve immediately.
      }
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

    // enable() schedules a fire-and-forget runRefreshNotes(genE) from
    // the initial appleNotes:on config. That refresh suspends on the
    // FIRST probeNotesAvailable call.
    const enabled = await mgr.enable(7338);
    expect(enabled.ok).toBe(true);

    // Let the constructor probe drain (call #1) and the
    // enable()-scheduled refresh reach its own probe await (call #2).
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(probeCalls.length).toBe(2);
    expect(writeNoteCalls.length).toBe(0);

    // Toggle OFF then back ON. The OFF→ON sequence keeps
    // `appleNotes.enabled === true` at the time the prior refresh
    // wakes up after the probe, so the post-probe `!appleNotes.enabled`
    // gate cannot bail the worker — only the generation gate can.
    // Without the bump, the prior refresh's `scheduledGeneration ===
    // this.generation` after these toggles (no bumps), so it would
    // proceed to writeNote. With the bump, the off+on persists each
    // bumped generation, so the prior refresh's
    // `scheduledGeneration (genE) !== this.generation (genE+2)`
    // supersedes it before writeNote can fire.
    const offResult = await mgr.setAppleNotesEnabled(false);
    expect(offResult.ok).toBe(true);
    const onResult = await mgr.setAppleNotesEnabled(true);
    expect(onResult.ok).toBe(true);

    // Release the suspended probe. The prior refresh resumes. With
    // the bump it bails at the gen-mismatch gate; without the bump
    // it would proceed and call writeNote.
    releaseFirstProbe();
    await new Promise((resolve) => setTimeout(resolve, 25));

    // The bump is the load-bearing change: with `setAppleNotesEnabled`
    // bumping `this.generation` on each transition, the off+on
    // sequence shifts `this.generation` past the prior refresh's
    // captured `scheduledGeneration`, so it bails at its post-probe
    // gen-mismatch gate before `writeNote` lands. Without the bump,
    // the prior refresh ALSO writes (its scheduledGeneration would
    // still equal `this.generation`), so the test would see TWO
    // writeNote calls. The on-toggle's own follow-up refresh is the
    // one legitimate writeNote that runs against the on-state.
    expect(writeNoteCalls.length).toBe(1);

    // The final snapshot reflects the on-toggle's state (the user's
    // most recent intent).
    const final = mgr.current();
    expect(final.appleNotes.enabled).toBe(true);

    __resetTunnelManagerForTests();
  });
});
