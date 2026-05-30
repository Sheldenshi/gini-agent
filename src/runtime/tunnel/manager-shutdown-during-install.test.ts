// Pins two failure-window invariants on swapCloudflared's cloudflared
// provisioning step:
//
//   (R3) A SIGTERM that flips `shuttingDown` WHILE the binary is being
//        resolved/downloaded (the long `await ensureCloudflaredBin(...)`)
//        must abort the swap BEFORE launchCloudflared is ever called. The
//        bounded shutdown drain has already run; spawning a brand-new
//        cloudflared after it would leave a process outliving the drain.
//        The post-install re-check (manager.ts, immediately after the
//        ensureCloudflaredBin await) closes that gap.
//
//   (M2) A residual spawn ENOENT — only reachable now via a resolve→spawn
//        TOCTOU since the manager resolves a real binary first, and no
//        longer rewritten into a three-OS blob by cloudflared.ts — must be
//        classified into the actionable `cloudflared_unavailable` shape
//        (typed code + install hint) rather than surfacing as a generic
//        lastErrorCode:null. This mirrors the stamping the
//        ensureCloudflaredBin catch already does.

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../../types";
import { removeMemoryDb } from "../../state/memory-db";
import { buildWriteNoteScript as realBuildWriteNoteScript } from "./apple-notes";

const INSTANCE = "manager-shutdown-during-install-test";

function seedConfig(tmp: string): void {
  const instanceDir = join(tmp, "instances", INSTANCE);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(
    join(instanceDir, "config.json"),
    JSON.stringify({
      tunnel: { enabled: false, secret: "T".repeat(48), appleNotes: { enabled: false } }
    }),
    "utf8"
  );
}

function runtimeConfig(tmp: string): RuntimeConfig {
  return {
    instance: INSTANCE,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: join(tmp, "instances", INSTANCE),
    logRoot: join(tmp, "logs", INSTANCE)
  };
}

describe("TunnelManager swapCloudflared install-window guards", () => {
  let tmp: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gini-manager-shutdown-install-"));
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = tmp;
    seedConfig(tmp);
  });

  afterEach(() => {
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    // Evict the cached bun:sqlite handle for this instance before the
    // on-disk file is removed; a retained handle over a deleted file
    // surfaces as SQLITE_IOERR_VNODE on the next memory-db touch.
    removeMemoryDb(INSTANCE);
    rmSync(tmp, { recursive: true, force: true });
    mock.restore();
  });

  test("R3: a shuttingDown flip during the install await aborts before any spawn", async () => {
    // Web child is healthy so the swap proceeds to the binary-resolution
    // step — the failure under test is the shutdown flip, not an unhealthy
    // port.
    mock.module("../health-probe", () => ({
      isSupervisedWebChild: async () => true
    }));
    mock.module("./apple-notes", () => ({
      probeNotesAvailable: async () => ({ available: false }),
      writeNote: async () => {},
      clearNote: async () => {},
      buildWriteNoteScript: realBuildWriteNoteScript
    }));

    // launchCloudflared is the spawn the post-install re-check must
    // prevent. If it's reached at all, the guard regressed.
    let launchCalls = 0;
    mock.module("./cloudflared", () => ({
      launchCloudflared: () => {
        launchCalls += 1;
        throw new Error("launchCloudflared must not run once shutdown has started");
      }
    }));

    // The manager reference is wired in after construction; the mocked
    // ensureCloudflaredBin only reads it at await-time, which is strictly
    // after the assignment below.
    let managerRef: { stopForShutdown: () => Promise<void> } | null = null;
    // Model the long first-use download: while we're "downloading", a
    // SIGTERM arrives and stopForShutdown() flips `shuttingDown` (its first
    // synchronous statement) and drains. We await it so the flag is set
    // before resolving the binary path the swap was waiting on.
    const realCfInstall = await import("./cloudflared-install");
    mock.module("./cloudflared-install", () => ({
      ...realCfInstall,
      ensureCloudflaredBin: async () => {
        await managerRef!.stopForShutdown();
        return "/tmp/fake-cloudflared";
      }
    }));

    const { __resetTunnelManagerForTests, tunnelManager } = await import("./manager");
    __resetTunnelManagerForTests();
    const mgr = tunnelManager(runtimeConfig(tmp));
    managerRef = mgr;

    const result = await mgr.enable(7338);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Same shutdown-abort shape as the other post-await shutdown checks.
      expect(result.error).toBe("Tunnel manager shutting down");
      // A shutdown abort is not an operator-actionable transition code.
      expect(result.code).toBeUndefined();
    }
    // The load-bearing assertion: NO cloudflared was spawned.
    expect(launchCalls).toBe(0);

    const snap = mgr.current();
    expect(snap.publicUrl).toBeNull();

    __resetTunnelManagerForTests();
  });

  test("M2: a residual spawn ENOENT surfaces code=cloudflared_unavailable", async () => {
    mock.module("../health-probe", () => ({
      isSupervisedWebChild: async () => true
    }));
    mock.module("./apple-notes", () => ({
      probeNotesAvailable: async () => ({ available: false }),
      writeNote: async () => {},
      clearNote: async () => {},
      buildWriteNoteScript: realBuildWriteNoteScript
    }));

    // ensureCloudflaredBin resolves a "real" binary — the ENOENT happens
    // AT SPAWN (resolve→spawn TOCTOU). launchCloudflared returns a launch
    // whose publicUrl rejects with a raw ENOENT-coded error, exactly as
    // cloudflared.ts now propagates it (translateSpawnError is gone). A
    // non-throwing process stub keeps the catch's alreadyExited branch
    // from invoking stop() against a dead process.
    mock.module("./cloudflared", () => {
      const enoent = Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" });
      return {
        launchCloudflared: () => ({
          process: {
            once: (_event: string, _cb: (...args: unknown[]) => void) => {
              /* swap installs an exit listener; never fire it */
            },
            exitCode: null,
            signalCode: null
          },
          publicUrl: Promise.reject(enoent),
          stop: async () => { /* no-op */ }
        })
      };
    });

    const realCfInstall = await import("./cloudflared-install");
    mock.module("./cloudflared-install", () => ({
      ...realCfInstall,
      ensureCloudflaredBin: async () => "/tmp/fake-cloudflared"
    }));

    const { __resetTunnelManagerForTests, tunnelManager } = await import("./manager");
    __resetTunnelManagerForTests();
    const mgr = tunnelManager(runtimeConfig(tmp));

    const result = await mgr.enable(7338);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cloudflared_unavailable");
    }

    const snap = mgr.current();
    expect(snap.enabled).toBe(false);
    expect(snap.lastErrorCode).toBe("cloudflared_unavailable");
    expect(snap.publicUrl).toBeNull();
    // The install hint must be a real, populated hint (drives the
    // install-guidance UI) rather than the dropped three-OS blob.
    expect(["macos", "linux", "windows", "other"]).toContain(snap.cloudflaredInstall.platform);
    expect(snap.cloudflaredInstall.command.length).toBeGreaterThan(0);

    __resetTunnelManagerForTests();
  });
});
