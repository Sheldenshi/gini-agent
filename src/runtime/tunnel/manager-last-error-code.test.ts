// Pins the typed `lastErrorCode` contract on the TunnelSnapshot: the
// manager must stamp `lastErrorCode: "web_port_unhealthy"` on the
// snapshot whenever it sets `lastError` to the web-port-unhealthy
// prose, so mobile and the settings card can branch on the typed code
// without substring-matching the human-readable error text. Failures
// that are not web-port-unhealthy stamp `lastErrorCode: null` so a
// consumer reading `snapshot.lastErrorCode === "web_port_unhealthy"`
// only matches the operator-actionable failure mode.

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeMemoryDb } from "../../state/memory-db";

const INSTANCE = "manager-last-error-code-test";

describe("TunnelSnapshot.lastErrorCode tracks the TunnelTransitionErrorCode union", () => {
  let tmp: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gini-manager-last-error-code-"));
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

  test("initial snapshot stamps lastErrorCode: null", async () => {
    mock.module("./apple-notes", () => ({
      probeNotesAvailable: async () => ({ available: true }),
      writeNote: async () => {},
      clearNote: async () => {}
    }));
    mock.module("./cloudflared", () => ({
      launchCloudflared: () => {
        throw new Error("not used in this test");
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

    const snapshot = mgr.current();
    expect(snapshot.lastErrorCode).toBe(null);
    expect(snapshot.lastError).toBe(null);

    __resetTunnelManagerForTests();
  });

  test("enable() failure with web_port_unhealthy stamps lastErrorCode on the snapshot", async () => {
    mock.module("../health-probe", () => ({
      isSupervisedWebChild: async () => false
    }));
    mock.module("./apple-notes", () => ({
      probeNotesAvailable: async () => ({ available: true }),
      writeNote: async () => {},
      clearNote: async () => {}
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

    const result = await mgr.enable(7338);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("web_port_unhealthy");
    }
    const snapshot = mgr.current();
    // The typed code is stamped on the snapshot alongside the human-
    // readable prose so a consumer can branch on the code without
    // substring-matching `lastError`.
    expect(snapshot.lastErrorCode).toBe("web_port_unhealthy");
    expect(snapshot.lastError).toContain("not healthy");

    __resetTunnelManagerForTests();
  });
});
