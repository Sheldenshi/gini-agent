// Pins the rotateSecret() pre-commit abort contract: when the
// pre-flight `web_port_unhealthy` return fires BEFORE the new secret
// has been persisted to disk, the finally-block purge MUST NOT wipe
// tunnel-origin device rows. The rows are bound to the OLD secret;
// purging them when the old secret is still the live one would
// silently revoke every paired phone whose cookie still validly
// matches what's running, breaking push delivery until each device
// re-launches and re-registers.

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeMemoryDb, getMemoryDb } from "../../state/memory-db";
import { listAllDevices, upsertDevice } from "../../state/devices";

const INSTANCE = "manager-rotate-no-purge-test";

describe("rotateSecret pre-commit abort leaves device rows intact", () => {
  let tmp: string;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gini-manager-rotate-no-purge-"));
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
    // Pre-warm the database for this instance so the tunnel-origin
    // row insert below has a backing store.
    getMemoryDb(INSTANCE);
  });

  afterEach(() => {
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    removeMemoryDb(INSTANCE);
    rmSync(tmp, { recursive: true, force: true });
    mock.restore();
  });

  test("web_port_unhealthy pre-flight return: code is set AND no tunnel rows are purged", async () => {
    // Step 1: a successful enable() so cloudflared/lastWebPort are set
    // and the rotateSecret pre-flight `if (this.cloudflared !== null
    // && this.lastWebPort !== null)` branch fires. We stub
    // cloudflared and the health probe so both the enable's probe
    // and the later rotate's pre-flight can flip independently.
    let probeShouldSucceed = true;
    mock.module("../health-probe", () => ({
      isSupervisedWebChild: async () => probeShouldSucceed
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

    const enabled = await mgr.enable(7338);
    expect(enabled.ok).toBe(true);

    // Step 2: plant a tunnel-origin device row. After the pre-commit
    // abort, this row MUST still be there — the old secret is still
    // the live one, so the cookie this row was issued against still
    // validates at the proxy.
    upsertDevice(INSTANCE, {
      token: "fake-tunnel-token",
      credentialId: "owner",
      platform: "ios",
      bundleId: "ai.lilac.gini",
      origin: "tunnel"
    });
    expect(listAllDevices(INSTANCE).length).toBe(1);

    // Step 3: flip the probe to unhealthy and call rotateSecret. The
    // pre-flight check at `if (this.cloudflared !== null && this.lastWebPort
    // !== null)` runs `isSupervisedWebChild` and returns the typed
    // code without persisting the new secret. The finally-block must
    // observe `didCommitNewSecret === false` and skip the purge.
    probeShouldSucceed = false;
    const rotated = await mgr.rotateSecret();

    expect(rotated.ok).toBe(false);
    if (!rotated.ok) {
      expect(rotated.code).toBe("web_port_unhealthy");
    }

    // Step 4: the tunnel-origin row is still there. If the finally-
    // block had purged unconditionally, listAllDevices would be empty.
    const remaining = listAllDevices(INSTANCE);
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.origin).toBe("tunnel");

    __resetTunnelManagerForTests();
  });
});
