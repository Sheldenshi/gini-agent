// Pins the cloudflared-unavailable failure path: when the web child is
// healthy but the cloudflared binary can't be resolved or installed (an
// offline first enable), enable() must return code="cloudflared_unavailable"
// and stamp the platform-appropriate install hint onto the snapshot so the UI
// can render actionable guidance instead of a raw spawn error. The pre-fix
// behavior was a raw ENOENT string with all three OS install commands mashed
// together; see issue #190.

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeMemoryDb } from "../../state/memory-db";
import { buildWriteNoteScript as realBuildWriteNoteScript } from "./apple-notes";
// Snapshot the REAL cloudflared-install export VALUES at module-eval
// time, before any mock rebinds the live namespace. A snapshot taken
// inside the test body via `await import(...)` is too late once a
// sibling test file has registered its own mock.module for this path.
// This test deliberately overrides ensureCloudflaredBin (to throw),
// manualInstallHint, and CloudflaredUnavailableError; the afterEach
// restore re-registers this pristine snapshot so none of those leak
// into cloudflared-install.test.ts (mock.restore() does not unregister
// mock.module factories).
import * as cloudflaredInstall from "./cloudflared-install";
const realCfInstall = { ...cloudflaredInstall };

const INSTANCE = "manager-cloudflared-unavailable-test";

describe("TunnelManager surfaces cloudflared_unavailable when install fails", () => {
  let tmp: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gini-manager-cf-unavailable-"));
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = tmp;
    const instanceDir = join(tmp, "instances", INSTANCE);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(
      join(instanceDir, "config.json"),
      JSON.stringify({
        tunnel: { enabled: false, secret: "T".repeat(48), appleNotes: { enabled: false } }
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
    // the pristine cloudflared-install snapshot to undo our overrides
    // (throwing ensureCloudflaredBin, the local error class, the stub hint)
    // before the next test file in this process runs.
    mock.module("./cloudflared-install", () => ({ ...realCfInstall }));
  });

  test("enable() returns code=cloudflared_unavailable and stamps the install hint", async () => {
    // Web child is healthy — the failure is purely the missing binary.
    mock.module("../health-probe", () => ({
      isSupervisedWebChild: async () => true
    }));
    mock.module("./apple-notes", () => ({
      probeNotesAvailable: async () => ({ available: true }),
      writeNote: async () => {},
      clearNote: async () => {},
      buildWriteNoteScript: realBuildWriteNoteScript
    }));
    // launchCloudflared must never be reached — the resolver fails first.
    mock.module("./cloudflared", () => ({
      launchCloudflared: () => {
        throw new Error("launchCloudflared should not be reached when cloudflared is unavailable");
      }
    }));
    // Force the resolver to fail as it would on an offline first enable. The
    // mocked error class IS the one the manager imports, so its `instanceof`
    // check resolves the carried hint rather than recomputing it.
    const hint = {
      platform: "macos" as const,
      command: "curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz | tar -xz && sudo mv cloudflared /usr/local/bin/",
      url: "https://github.com/cloudflare/cloudflared/releases"
    };
    class CloudflaredUnavailableError extends Error {
      hint = hint;
      constructor(message: string) {
        super(message);
        this.name = "CloudflaredUnavailableError";
      }
    }
    // ...realCfInstall keeps the full public surface
    // (CLOUDFLARED_RELEASES_URL, cloudflaredAssetFor, findCloudflaredOnPath,
    // …) real; we then override the three exports this test drives:
    // ensureCloudflaredBin throws the offline failure, and
    // CloudflaredUnavailableError is the LOCAL class so the manager's
    // `instanceof` check (manager.ts:430) matches and extracts the
    // carried hint rather than recomputing it from the host platform.
    // The afterEach restore re-registers the pristine snapshot so these
    // overrides can't leak into cloudflared-install.test.ts.
    mock.module("./cloudflared-install", () => ({
      ...realCfInstall,
      ensureCloudflaredBin: async () => {
        throw new CloudflaredUnavailableError(
          "cloudflared could not be installed automatically (offline). Check your internet connection and try again, or install it manually."
        );
      },
      manualInstallHint: () => hint,
      CloudflaredUnavailableError
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

    const result = await mgr.enable(7338);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cloudflared_unavailable");
      expect(result.error).toContain("install it manually");
    }

    const snap = mgr.current();
    expect(snap.enabled).toBe(false);
    expect(snap.lastErrorCode).toBe("cloudflared_unavailable");
    expect(snap.publicUrl).toBeNull();
    expect(snap.cloudflaredInstall.platform).toBe("macos");
    expect(snap.cloudflaredInstall.command).toContain("tar -xz");

    __resetTunnelManagerForTests();
  });
});
