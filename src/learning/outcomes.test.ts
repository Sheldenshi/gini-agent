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
    let payerId = "";
    let notifierId = "";
    await mutateState(instance, (state) => {
      const payer = createSkill(state, {
        name: "payer",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: ["messaging.send"],
        status: "enabled"
      });
      payerId = payer.id;
      // A SECOND distinct skill for the success row — outcomes collapse per
      // (skill, task), so the failure and the success must be different skills.
      const notifier = createSkill(state, {
        name: "notifier",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: ["messaging.send"],
        status: "enabled"
      });
      notifierId = notifier.id;
      addAudit(
        state,
        {
          actor: "agent",
          action: "skill.script.invoked",
          target: payer.id,
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
          target: notifier.id,
          risk: "medium",
          taskId: "task_1",
          evidence: { skill: "notifier", script: "status.sh", ok: true, exitCode: 0, stdoutBytes: 4, stderrBytes: 0 }
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
    expect(failure!.skillId).toBe(payerId);
    expect(failure!.exitCode).toBe(7);
    expect(failure!.scriptName).toBe("pay.sh");
    // requiredPermissions on the skill makes it consequential.
    expect(failure!.consequential).toBe(true);
    // A failure's terminal/exit status is an objective signal.
    expect(failure!.selfVerifiable).toBe(true);
    expect(success).toBeDefined();
    expect(success!.skillId).toBe(notifierId);
    // The success ran a consequential skill (messaging.send permission), so the
    // ok exit proves it EXECUTED, not that it was correct -> not self-verifiable.
    expect(success!.consequential).toBe(true);
    expect(success!.selfVerifiable).toBe(false);
  });

  test("retried invocations of one skill collapse to a single outcome per task", async () => {
    const instance = "dedup";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "flaky",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
      // Three retries of the same script in ONE task.
      for (let i = 0; i < 3; i += 1) {
        addAudit(
          state,
          {
            actor: "agent",
            action: "skill.script.invoked",
            target: skill.id,
            risk: "medium",
            taskId: "task_d",
            evidence: {
              skill: "flaky",
              script: "run.sh",
              ok: false,
              exitCode: 1,
              stdoutBytes: 0,
              stderrBytes: 5,
              stderrSnippet: "Script exited 1: upstream service returned 503"
            }
          },
          { taskId: "task_d" }
        );
      }
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_d", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_d");
    // One task is one trajectory: retries must NOT inflate the per-skill failure
    // count that gates reflection's >=2-distinct-trajectory floor.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.signal).toBe("failure");
    expect(outcomes[0]!.exitCode).toBe(1);
    // The scrubbed failure reason persisted on the audit row flows into
    // errorDetail so the classifier sees WHY the script failed.
    expect(outcomes[0]!.errorDetail).toContain("503");
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

  test("an ok script with no consequence is self-verifiable", async () => {
    const instance = "selfverif";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "lookup",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
      addAudit(
        state,
        {
          actor: "agent",
          action: "skill.script.invoked",
          target: skill.id,
          risk: "low",
          taskId: "task_lu",
          evidence: { skill: "lookup", script: "lookup.sh", ok: true, exitCode: 0, stdoutBytes: 4, stderrBytes: 0 }
        },
        { taskId: "task_lu" }
      );
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_lu", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_lu");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.signal).toBe("success");
    // No requiredPermissions and no side-effecting audit row -> not consequential
    // -> self-verifiable (the ok exit is an objective signal of correctness).
    expect(outcomes[0]!.consequential).toBe(false);
    expect(outcomes[0]!.selfVerifiable).toBe(true);
  });

  test("a consequential side-effecting completion with no script records a tier-2 sample row", async () => {
    const instance = "tier2";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      // A messaging send the task carried out, but no skill script ran.
      addAudit(
        state,
        {
          actor: "agent",
          action: "messaging.sent",
          target: "thread_1",
          risk: "medium",
          taskId: "task_t2"
        },
        { taskId: "task_t2" }
      );
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_t2", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_t2");
    expect(outcomes).toHaveLength(1);
    const row = outcomes[0]!;
    expect(row.signal).toBe("success");
    expect(row.source).toBe("objective");
    expect(row.consequential).toBe(true);
    // The defining property: a consequential action with no objective
    // correctness check is NOT self-verifiable, so the daily review can sample it.
    expect(row.selfVerifiable).toBe(false);
    // No single skill script ran -> unattributed.
    expect(row.skillId).toBeUndefined();
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
