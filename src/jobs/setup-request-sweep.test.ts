import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateState, now, readState } from "../state";
import type { RuntimeConfig, SetupRequest, Task } from "../types";
import { SETUP_REQUEST_TTL_MS, runSetupRequestSweep } from "./setup-request-sweep";

const ROOT = mkdtempSync(join(tmpdir(), "gini-setup-sweep-test-"));

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
    port: 7340,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

async function seedTask(config: RuntimeConfig, taskId: string): Promise<void> {
  await mutateState(config.instance, (state) => {
    const at = now();
    const task: Task = {
      id: taskId,
      title: taskId,
      input: "",
      status: "waiting_approval",
      instance: state.instance,
      createdAt: at,
      updatedAt: at,
      tracePath: "",
      auditIds: [],
      approvalIds: [],
      skillIds: []
    };
    state.tasks.push(task);
  });
}

async function seedSetupRequest(
  config: RuntimeConfig,
  overrides: Partial<SetupRequest> & Pick<SetupRequest, "id" | "status" | "createdAt">
): Promise<void> {
  await mutateState(config.instance, (state) => {
    const setupRequest: SetupRequest = {
      instance: state.instance,
      updatedAt: overrides.createdAt,
      action: "browser.fill_secret",
      target: "https://example.com",
      reason: "test setup",
      payload: {},
      ...overrides
    };
    state.setupRequests.push(setupRequest);
  });
}

describe("runSetupRequestSweep", () => {
  beforeEach(async () => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("cancels an abandoned fill_secret request and fails its task", async () => {
    const config = buildConfig("sweep-expire");
    await seedTask(config, "task_old");
    const old = new Date(Date.now() - SETUP_REQUEST_TTL_MS - 60_000).toISOString();
    await seedSetupRequest(config, { id: "setup_old", taskId: "task_old", status: "pending", createdAt: old });

    const report = await runSetupRequestSweep(config);

    expect(report.expired).toContain("setup_old");
    const state = readState(config.instance);
    expect(state.setupRequests.find((r) => r.id === "setup_old")?.status).toBe("cancelled");
    expect(state.tasks.find((t) => t.id === "task_old")?.status).toBe("failed");
  });

  test("leaves a recent pending request untouched", async () => {
    const config = buildConfig("sweep-fresh");
    await seedTask(config, "task_fresh");
    await seedSetupRequest(config, {
      id: "setup_fresh",
      taskId: "task_fresh",
      status: "pending",
      createdAt: now()
    });

    const report = await runSetupRequestSweep(config);

    expect(report.expired).not.toContain("setup_fresh");
    const state = readState(config.instance);
    expect(state.setupRequests.find((r) => r.id === "setup_fresh")?.status).toBe("pending");
    expect(state.tasks.find((t) => t.id === "task_fresh")?.status).toBe("waiting_approval");
  });

  test("ignores a non-pending request even when old", async () => {
    const config = buildConfig("sweep-resolved");
    const old = new Date(Date.now() - SETUP_REQUEST_TTL_MS - 60_000).toISOString();
    await seedSetupRequest(config, { id: "setup_done", status: "completed", createdAt: old });

    const report = await runSetupRequestSweep(config);

    expect(report.expired).toEqual([]);
    expect(report.considered).toBe(0);
    const state = readState(config.instance);
    expect(state.setupRequests.find((r) => r.id === "setup_done")?.status).toBe("completed");
  });
});
