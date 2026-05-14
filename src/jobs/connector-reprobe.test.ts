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
