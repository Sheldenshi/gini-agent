// Pins the typed `code: "web_port_unhealthy"` contract on the manager's
// failure paths. The PATCH /api/tunnel handler now keys its 409-vs-500
// status mapping off this discrete code instead of substring-matching the
// human-readable prose, so a future reword of the error message can't
// silently flip an operator-actionable 409 into a generic 500.

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTANCE = "manager-unhealthy-code-test";

describe("TunnelManager typed error code on health-probe failure", () => {
  let tmp: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gini-manager-unhealthy-"));
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = tmp;
    const instanceDir = join(tmp, "instances", INSTANCE);
    mkdirSync(instanceDir, { recursive: true });
    // Seed a healthy config block so the manager constructor doesn't
    // need to mint a secret (mint is idempotent but writes the file).
    writeFileSync(
      join(instanceDir, "config.json"),
      JSON.stringify({
        tunnel: {
          enabled: false,
          secret: "T".repeat(48),
          appleNotes: { enabled: false }
        }
      }),
      "utf8"
    );
  });

  afterEach(() => {
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    rmSync(tmp, { recursive: true, force: true });
    mock.restore();
  });

  test("enable() surfaces code=web_port_unhealthy when the inline health probe fails", async () => {
    // Force the probe to fail without standing up a real Next.js child.
    // swapCloudflared re-probes inside its apply-chain slot; the failure
    // branch is the load-bearing return statement under test.
    mock.module("../health-probe", () => ({
      isSupervisedWebChild: async () => false
    }));
    // Block any real cloudflared spawn — the unhealthy branch should
    // return BEFORE we get to launchCloudflared, but defense-in-depth
    // in case the test environment has cloudflared on PATH.
    mock.module("./cloudflared", () => ({
      launchCloudflared: () => {
        throw new Error("launchCloudflared should not be reached when probe fails");
      }
    }));

    // Reset the manager singleton AFTER the mocks are installed so the
    // freshly minted instance binds to the mocked health-probe import.
    const { __resetTunnelManagerForTests, tunnelManager } = await import("./manager");
    __resetTunnelManagerForTests();
    const result = await tunnelManager({
      instance: INSTANCE,
      port: 7337,
      token: "test-token",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: join(tmp, "instances", INSTANCE),
      logRoot: join(tmp, "logs", INSTANCE)
    }).enable(7338);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("web_port_unhealthy");
      expect(result.error).toContain("not healthy");
    }
    __resetTunnelManagerForTests();
  });

  test("rotateSecret() surfaces code=web_port_unhealthy when pre-flight probe fails after a live tunnel", async () => {
    // We need cloudflared to be non-null inside rotateSecret so the
    // pre-flight `if (this.cloudflared !== null && this.lastWebPort !== null)`
    // branch fires. We stand up a stub cloudflared, drive a successful
    // enable() to plant `this.cloudflared` and `this.lastWebPort`,
    // then flip the probe to unhealthy and invoke rotateSecret().
    let probeShouldSucceed = true;
    mock.module("../health-probe", () => ({
      isSupervisedWebChild: async () => probeShouldSucceed
    }));
    mock.module("./cloudflared", () => ({
      launchCloudflared: () => ({
        // Minimal CloudflaredLaunch shape: a publicUrl promise that
        // resolves to a fake trycloudflare URL, a no-op process with
        // an `once` listener registry, and a stop() that resolves.
        // exitCode AND signalCode must be null — the manager's post-
        // banner same-tick-exit guard checks both, and an undefined
        // signalCode would trip the !== null check and abort enable.
        process: {
          once: (_event: string, _cb: (...args: unknown[]) => void) => {
            /* swap installs an exit listener; never fire it */
          },
          exitCode: null,
          signalCode: null
        },
        publicUrl: Promise.resolve("https://fake-test.trycloudflare.com"),
        stop: async () => { /* no-op */ }
      })
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

    // Drive a successful enable so cloudflared and lastWebPort are set.
    const enabled = await mgr.enable(7338);
    expect(enabled.ok).toBe(true);

    // Flip the probe to unhealthy. rotateSecret's pre-flight check is
    // the load-bearing return at manager.ts:807 — the one we surface
    // the typed code on.
    probeShouldSucceed = false;
    const rotated = await mgr.rotateSecret();

    expect(rotated.ok).toBe(false);
    if (!rotated.ok) {
      expect(rotated.code).toBe("web_port_unhealthy");
      expect(rotated.error).toContain("not healthy");
    }
    __resetTunnelManagerForTests();
  });
});
