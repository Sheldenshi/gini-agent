// Objective outcome extraction (ADR skill-learning-from-outcomes.md):
// from synthetic skill.script.invoked audit rows + task status —
//  - a non-zero exit yields an attributed failure,
//  - an ok invocation a success,
//  - a script-less failed task an unattributed failure row,
//  - error text is scrubbed.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { addAudit, createSkill, mutateState, readState } from "../state";
import { recordObjectiveOutcomes, recordFeedbackOutcome } from "./outcomes";
import type { RuntimeConfig, Task } from "../types";

const ROOT = "/tmp/gini-outcomes-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

function makeTask(instance: string, id: string, status: Task["status"], error?: string): Task {
  const at = new Date().toISOString();
  return {
    id,
    title: "t",
    input: "t",
    status,
    instance,
    agentId: "agent_test",
    createdAt: at,
    updatedAt: at,
    error,
    tracePath: "",
    auditIds: [],
    approvalIds: [],
    skillIds: []
  };
}

describe("recordObjectiveOutcomes", () => {
  test("non-zero exit yields an attributed failure; ok yields a success", async () => {
    const instance = "attr";
    const config = makeConfig(instance);
    let skillId = "";
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "payer",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: ["messaging.send"],
        status: "enabled"
      });
      skillId = skill.id;
      addAudit(
        state,
        {
          actor: "agent",
          action: "skill.script.invoked",
          target: skill.id,
          risk: "medium",
          taskId: "task_1",
          evidence: { skill: "payer", script: "pay.sh", ok: false, exitCode: 7, stdoutBytes: 0, stderrBytes: 12 }
        },
        { taskId: "task_1" }
      );
      addAudit(
        state,
        {
          actor: "agent",
          action: "skill.script.invoked",
          target: skill.id,
          risk: "medium",
          taskId: "task_1",
          evidence: { skill: "payer", script: "status.sh", ok: true, exitCode: 0, stdoutBytes: 4, stderrBytes: 0 }
        },
        { taskId: "task_1" }
      );
    });

    await recordObjectiveOutcomes(config, makeTask(instance, "task_1", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_1");
    expect(outcomes).toHaveLength(2);
    const failure = outcomes.find((o) => o.signal === "failure");
    const success = outcomes.find((o) => o.signal === "success");
    expect(failure).toBeDefined();
    expect(failure!.skillId).toBe(skillId);
    expect(failure!.exitCode).toBe(7);
    expect(failure!.scriptName).toBe("pay.sh");
    // requiredPermissions on the skill makes it consequential.
    expect(failure!.consequential).toBe(true);
    expect(failure!.selfVerifiable).toBe(true);
    expect(success).toBeDefined();
    expect(success!.skillId).toBe(skillId);
  });

  test("script-less failed task yields one unattributed failure row", async () => {
    const instance = "unattr";
    const config = makeConfig(instance);
    readState(instance);
    await recordObjectiveOutcomes(
      config,
      makeTask(instance, "task_x", "failed", "boom: x-api-key: sk-secret-123")
    );
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_x");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.signal).toBe("failure");
    expect(outcomes[0]!.skillId).toBeUndefined();
    // Error text is scrubbed — the api key value must not survive.
    expect(outcomes[0]!.errorDetail).toBeDefined();
    expect(outcomes[0]!.errorDetail).not.toContain("sk-secret-123");
  });

  test("script-less completed task writes nothing", async () => {
    const instance = "noop";
    const config = makeConfig(instance);
    readState(instance);
    await recordObjectiveOutcomes(config, makeTask(instance, "task_ok", "completed"));
    expect(readState(instance).skillOutcomes).toHaveLength(0);
  });
});

describe("recordFeedbackOutcome", () => {
  test("a negative answer becomes a failure attributed to the named skill", async () => {
    const instance = "fb";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      createSkill(state, {
        name: "emailer",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
    });
    const out = await recordFeedbackOutcome(config, {
      skillName: "emailer",
      taskId: "task_fb",
      ok: false,
      detail: "sent to the wrong person"
    });
    expect(out.signal).toBe("failure");
    expect(out.source).toBe("user_feedback");
    expect(out.skillName).toBe("emailer");
    expect(out.consequential).toBe(true);
    expect(out.selfVerifiable).toBe(false);
    expect(out.feedbackPrompted).toBe(true);
  });
});
