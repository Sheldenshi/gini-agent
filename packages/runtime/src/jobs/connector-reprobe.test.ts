import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateState, readState } from "../state";
import type { RuntimeConfig } from "../types";
import { runConnectorReprobe } from "./connector-reprobe";

const ROOT = mkdtempSync(join(tmpdir(), "gini-reprobe-test-"));

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7339,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

describe("runConnectorReprobe", () => {
  beforeEach(async () => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("skips providers without a probe and counts considered connectors", async () => {
    const config = buildConfig("reprobe-noop");
    await mutateState(config.instance, () => undefined);
    const report = await runConnectorReprobe(config);
    expect(report.considered).toBeGreaterThan(0);
    // The default state ships with a `demo` connector. demo has no probe,
    // so it's considered but never probed.
    expect(report.probed).toBe(0);
  });

  test("skips disabled (tombstoned) connectors so detection-deleted auto records aren't resurrected", async () => {
    const config = buildConfig("reprobe-tombstone");
    // Stale lastHealthAt (>30m) ensures the interval gate would otherwise
    // allow a re-probe. Without the disabled-skip guard, the linear probe
    // would run and (when the connector has a probe) write back fresh
    // health/status — clobbering the tombstone.
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await mutateState(config.instance, (state) => {
      state.connectors.push({
        id: "id_linear_disabled",
        instance: state.instance,
        name: "tombstoned linear",
        provider: "linear",
        status: "disabled",
        scopes: [],
        secretRefs: [],
        source: "auto",
        createdAt: stale,
        updatedAt: stale,
        lastHealthAt: stale,
        health: "unknown"
      });
      state.connectors.push({
        id: "id_linear_active",
        instance: state.instance,
        name: "active linear",
        provider: "linear",
        status: "configured",
        scopes: [],
        secretRefs: [],
        source: "user",
        createdAt: stale,
        updatedAt: stale,
        lastHealthAt: stale,
        health: "healthy"
      });
    });
    const report = await runConnectorReprobe(config);
    const state = readState(config.instance);
    const disabled = state.connectors.find((c) => c.id === "id_linear_disabled");
    const active = state.connectors.find((c) => c.id === "id_linear_active");
    // Tombstoned record was never inspected — lastHealthAt unchanged,
    // status unchanged, health unchanged.
    expect(disabled?.lastHealthAt).toBe(stale);
    expect(disabled?.status).toBe("disabled");
    expect(disabled?.health).toBe("unknown");
    // Disabled record was filtered out *before* report.considered++, so
    // considered counts only the demo seed + active linear (2), not 3.
    expect(report.considered).toBe(2);
    // The active record went through the probe loop and lastHealthAt
    // advanced — proves the loop did run, just not on the tombstone.
    expect(active?.lastHealthAt).not.toBe(stale);
  });

  test("respects per-provider interval and skips fresh probes", async () => {
    const config = buildConfig("reprobe-fresh");
    await mutateState(config.instance, (state) => {
      state.connectors.push({
        id: "id_linear_fresh",
        instance: state.instance,
        name: "fresh linear",
        provider: "linear",
        status: "configured",
        scopes: [],
        secretRefs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Probed 1ms ago — the 30-minute interval is nowhere near elapsed.
        lastHealthAt: new Date().toISOString(),
        health: "healthy"
      });
    });
    const report = await runConnectorReprobe(config);
    // The new connector should NOT be re-probed because lastHealthAt is fresh.
    expect(report.transitioned).toEqual([]);
    const state = readState(config.instance);
    const linear = state.connectors.find((c) => c.id === "id_linear_fresh");
    // health untouched (still "healthy"); no audit transition event.
    expect(linear?.health).toBe("healthy");
  });
});
