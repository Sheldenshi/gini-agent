// Adversarial probes for objective outcome capture (ADR
// skill-learning-from-outcomes.md). These try to BREAK recordObjectiveOutcomes /
// recordFeedbackOutcome via ordering, per-task dedup, double-count guards,
// honesty (selfVerifiable/consequential), secret scrubbing, and robustness on
// malformed input. Slice: capture. UNIQUE state root so parallel probers don't
// collide.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { addAudit, createSkill, mutateState, readState } from "../state";
import { recordObjectiveOutcomes, recordFeedbackOutcome } from "./outcomes";
import type { RuntimeConfig, Task } from "../types";

const ROOT = "/tmp/gini-outcomes-probe-capture-test";

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

// Helper: add a skill.script.invoked audit row attributed to a skill id.
function addInvocation(
  state: ReturnType<typeof readState> extends infer _ ? any : never,
  taskId: string,
  skillId: string,
  evidence: Record<string, unknown>
) {
  addAudit(
    state,
    {
      actor: "agent",
      action: "skill.script.invoked",
      target: skillId,
      risk: "medium",
      taskId,
      evidence
    },
    { taskId }
  );
}

describe("recordObjectiveOutcomes — two distinct skills (one fail, one ok)", () => {
  test("attributes two outcomes with correct per-skill signals & details", async () => {
    const instance = "p_two_skills";
    const config = makeConfig(instance);
    let failId = "";
    let okId = "";
    await mutateState(instance, (state) => {
      const failer = createSkill(state, {
        name: "deployer",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [], // not consequential by permission
        status: "enabled"
      });
      failId = failer.id;
      const okSkill = createSkill(state, {
        name: "reporter",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
      okId = okSkill.id;
      addInvocation(state, "task_two", failer.id, {
        skill: "deployer",
        script: "deploy.sh",
        ok: false,
        exitCode: 13,
        stdoutBytes: 2,
        stderrBytes: 40,
        stderrSnippet: "Script exited 13: connection refused"
      });
      addInvocation(state, "task_two", okSkill.id, {
        skill: "reporter",
        script: "report.sh",
        ok: true,
        exitCode: 0,
        stdoutBytes: 9,
        stderrBytes: 0
      });
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_two", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_two");
    expect(outcomes).toHaveLength(2);

    const fail = outcomes.find((o) => o.skillId === failId);
    const ok = outcomes.find((o) => o.skillId === okId);
    expect(fail).toBeDefined();
    expect(ok).toBeDefined();

    expect(fail!.signal).toBe("failure");
    expect(fail!.exitCode).toBe(13);
    expect(fail!.scriptName).toBe("deploy.sh");
    expect(fail!.errorDetail).toContain("connection refused");
    // A failure's terminal status is always an objective signal.
    expect(fail!.selfVerifiable).toBe(true);

    expect(ok!.signal).toBe("success");
    // No permissions, no side-effect row -> self-verifiable success.
    expect(ok!.consequential).toBe(false);
    expect(ok!.selfVerifiable).toBe(true);
    expect(ok!.errorDetail).toBeUndefined();
  });
});

describe("recordObjectiveOutcomes — per-task dedup (same skill 3x: 2 fail, 1 ok)", () => {
  test("collapses to ONE failure outcome for the skill", async () => {
    const instance = "p_dedup_mixed";
    const config = makeConfig(instance);
    let skillId = "";
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
      skillId = skill.id;
      // Interleave failures and a success across THREE invocations in one task.
      addInvocation(state, "task_mix", skill.id, {
        skill: "flaky",
        script: "run.sh",
        ok: false,
        exitCode: 2,
        stdoutBytes: 0,
        stderrBytes: 8,
        stderrSnippet: "Script exited 2: first failure detail"
      });
      addInvocation(state, "task_mix", skill.id, {
        skill: "flaky",
        script: "run.sh",
        ok: true,
        exitCode: 0,
        stdoutBytes: 3,
        stderrBytes: 0
      });
      addInvocation(state, "task_mix", skill.id, {
        skill: "flaky",
        script: "run.sh",
        ok: false,
        exitCode: 9,
        stdoutBytes: 0,
        stderrBytes: 8,
        stderrSnippet: "Script exited 9: second failure detail"
      });
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_mix", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_mix");
    // One task = one trajectory: the per-(skill,task) outcome collapses to one row.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.skillId).toBe(skillId);
    // ANY failure makes the outcome a failure.
    expect(outcomes[0]!.signal).toBe("failure");
    // The representative exit/detail comes from the FIRST failure seen during
    // iteration over invocations. audit rows are unshifted (newest-first), so the
    // first failure iterated is the LAST-added failure (exit 9).
    expect(outcomes[0]!.exitCode).toBe(9);
    expect(outcomes[0]!.errorDetail).toContain("second failure detail");
  });

  test("dedup is robust to a leading success then later failures", async () => {
    const instance = "p_dedup_ok_first";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "ordered",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
      // Added oldest-first; the success is the OLDEST (iterated last).
      addInvocation(state, "task_of", skill.id, {
        skill: "ordered",
        script: "x.sh",
        ok: true,
        exitCode: 0,
        stdoutBytes: 1,
        stderrBytes: 0
      });
      addInvocation(state, "task_of", skill.id, {
        skill: "ordered",
        script: "x.sh",
        ok: false,
        exitCode: 4,
        stdoutBytes: 0,
        stderrBytes: 5,
        stderrSnippet: "Script exited 4: boom"
      });
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_of", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_of");
    expect(outcomes).toHaveLength(1);
    // A success seen before a failure must still produce a FAILURE outcome with
    // the failure's exit/detail (the prior success must not mask the failure).
    expect(outcomes[0]!.signal).toBe("failure");
    expect(outcomes[0]!.exitCode).toBe(4);
    expect(outcomes[0]!.errorDetail).toContain("boom");
  });
});

describe("recordObjectiveOutcomes — selfVerifiable / consequential honesty", () => {
  test("ok script on a skill with requiredPermissions is consequential -> not self-verifiable", async () => {
    const instance = "p_perm_success";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "sender",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: ["messaging.send"],
        status: "enabled"
      });
      addInvocation(state, "task_perm", skill.id, {
        skill: "sender",
        script: "send.sh",
        ok: true,
        exitCode: 0,
        stdoutBytes: 5,
        stderrBytes: 0
      });
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_perm", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_perm");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.signal).toBe("success");
    // requiredPermissions makes it consequential; a consequential success only
    // proves it EXECUTED, not that it was correct.
    expect(outcomes[0]!.consequential).toBe(true);
    expect(outcomes[0]!.selfVerifiable).toBe(false);
  });

  test("ok:true with NON-ZERO exit is treated as a failure", async () => {
    const instance = "p_ok_nonzero";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "mismatch",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
      // Contradictory evidence: ok=true but exitCode=5. The source treats this
      // as a failure (ok AND exit-zero are both required for success).
      addInvocation(state, "task_mm", skill.id, {
        skill: "mismatch",
        script: "m.sh",
        ok: true,
        exitCode: 5,
        stdoutBytes: 0,
        stderrBytes: 3,
        stderrSnippet: "weird"
      });
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_mm", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_mm");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.signal).toBe("failure");
    expect(outcomes[0]!.exitCode).toBe(5);
  });
});

describe("recordObjectiveOutcomes — errorDetail sourcing & scrubbing", () => {
  test("errorDetail falls back to scrubbed task.error when snippet absent", async () => {
    const instance = "p_fallback_detail";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "nosnip",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
      // Failure row WITHOUT a stderrSnippet -> errorDetail must fall back to the
      // task error, scrubbed.
      addInvocation(state, "task_fb", skill.id, {
        skill: "nosnip",
        script: "n.sh",
        ok: false,
        exitCode: 1,
        stdoutBytes: 0,
        stderrBytes: 0
      });
    });
    await recordObjectiveOutcomes(
      config,
      makeTask(instance, "task_fb", "failed", "task blew up with token=supersecretvalue99")
    );
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_fb");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.signal).toBe("failure");
    // Fell back to task.error...
    expect(outcomes[0]!.errorDetail).toContain("task blew up");
    // ...and that fallback is scrubbed — the secret value must not survive.
    expect(outcomes[0]!.errorDetail).not.toContain("supersecretvalue99");
  });

  // The producer (skill-scripts.ts) already runs redactSecrets+slice(0,300) over
  // stderr before persisting `stderrSnippet`, so by contract a persisted snippet
  // is clean. outcomes.ts trusts that and threads the snippet into errorDetail
  // VERBATIM (it does NOT re-scrub the snippet — only the task.error fallback is
  // scrubbed). This test PINS that trust boundary: a clean snippet survives
  // unchanged. (See "defense-in-depth" note in the bug report: a snippet that
  // somehow carried a secret would NOT be re-scrubbed here.)
  test("a clean (already-scrubbed) snippet flows into errorDetail verbatim", async () => {
    const instance = "p_snippet_verbatim";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "leaky",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
      addInvocation(state, "task_leak", skill.id, {
        skill: "leaky",
        script: "l.sh",
        ok: false,
        exitCode: 1,
        stdoutBytes: 0,
        stderrBytes: 50,
        // As the producer would have written it: already scrubbed.
        stderrSnippet: "auth failed using sk-*** and Bearer ***"
      });
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_leak", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_leak");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.errorDetail).toBe("auth failed using sk-*** and Bearer ***");
  });

  // The producer caps the snippet at 300; ERROR_DETAIL_CAP in outcomes.ts is 500.
  // A realistically-bounded snippet (<=300) survives in full — confirming the two
  // caps are compatible and the snippet is not truncated a second time.
  test("a producer-bounded snippet (<=300) is not re-truncated", async () => {
    const instance = "p_cap";
    const config = makeConfig(instance);
    const snippet = "x".repeat(300);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "verbose",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
      addInvocation(state, "task_cap", skill.id, {
        skill: "verbose",
        script: "v.sh",
        ok: false,
        exitCode: 1,
        stdoutBytes: 0,
        stderrBytes: 300,
        stderrSnippet: snippet
      });
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_cap", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_cap");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.errorDetail).toHaveLength(300);
  });
});

describe("recordObjectiveOutcomes — terminal status edge cases", () => {
  test("cancelled task with no script writes nothing", async () => {
    const instance = "p_cancelled";
    const config = makeConfig(instance);
    readState(instance);
    await recordObjectiveOutcomes(config, makeTask(instance, "task_cx", "cancelled"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_cx");
    // Only a `failed` status produces the unattributed failure; cancelled does not.
    expect(outcomes).toHaveLength(0);
  });

  test("failed task with no script -> one unattributed self-verifiable failure", async () => {
    const instance = "p_failed_noscript";
    const config = makeConfig(instance);
    readState(instance);
    await recordObjectiveOutcomes(
      config,
      makeTask(instance, "task_fn", "failed", "x-api-key: sk-deadbeefcafe")
    );
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_fn");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.signal).toBe("failure");
    expect(outcomes[0]!.skillId).toBeUndefined();
    expect(outcomes[0]!.consequential).toBe(false);
    expect(outcomes[0]!.selfVerifiable).toBe(true);
    expect(outcomes[0]!.errorDetail).not.toContain("sk-deadbeefcafe");
  });
});

describe("recordObjectiveOutcomes — side-effect / double-count guard", () => {
  test("a consequential success script + messaging row does NOT double-count", async () => {
    const instance = "p_no_double_success";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "msgr",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: ["messaging.send"],
        status: "enabled"
      });
      addInvocation(state, "task_nd", skill.id, {
        skill: "msgr",
        script: "send.sh",
        ok: true,
        exitCode: 0,
        stdoutBytes: 4,
        stderrBytes: 0
      });
      addAudit(
        state,
        { actor: "agent", action: "messaging.sent", target: "thread_x", risk: "medium", taskId: "task_nd" },
        { taskId: "task_nd" }
      );
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_nd", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_nd");
    // The recordedConsequentialSuccess guard must suppress the side-effect-only
    // fallback row -> exactly ONE row, not two.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.signal).toBe("success");
    expect(outcomes[0]!.consequential).toBe(true);
    expect(outcomes[0]!.selfVerifiable).toBe(false);
  });

  // ADVERSARIAL: a script that FAILED plus a messaging.sent side-effect row on a
  // completed task. recordedConsequentialSuccess stays false (the script outcome
  // was a failure), so the side-effect-only fallback can still fire and ALSO
  // record a consequential success — producing a phantom "success" for a task
  // whose only attributed work FAILED. This double-records contradictory signals.
  test("a failed script + messaging row should not also emit a phantom success", async () => {
    const instance = "p_fail_plus_sideeffect";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "halfsend",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
      addInvocation(state, "task_fp", skill.id, {
        skill: "halfsend",
        script: "send.sh",
        ok: false,
        exitCode: 1,
        stdoutBytes: 0,
        stderrBytes: 12,
        stderrSnippet: "Script exited 1: send failed"
      });
      addAudit(
        state,
        { actor: "agent", action: "messaging.sent", target: "thread_y", risk: "medium", taskId: "task_fp" },
        { taskId: "task_fp" }
      );
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_fp", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_fp");
    // The script outcome (a failure) should be the only attributed outcome.
    const failures = outcomes.filter((o) => o.signal === "failure");
    const successes = outcomes.filter((o) => o.signal === "success");
    expect(failures).toHaveLength(1);
    // A task whose only attributed script FAILED must NOT also yield a success
    // outcome from the side-effect fallback. A phantom success here would inflate
    // the tier-2 success sample with an action that actually failed.
    expect(successes).toHaveLength(0);
  });

  test("messaging-only completion (no script) records one tier-2 sample, unattributed", async () => {
    const instance = "p_msg_only";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      addAudit(
        state,
        { actor: "agent", action: "messaging.sent", target: "thread_z", risk: "medium", taskId: "task_mo" },
        { taskId: "task_mo" }
      );
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_mo", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_mo");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.signal).toBe("success");
    expect(outcomes[0]!.consequential).toBe(true);
    expect(outcomes[0]!.selfVerifiable).toBe(false);
    expect(outcomes[0]!.skillId).toBeUndefined();
  });

  test("authorization side-effect row makes a no-permission ok script consequential", async () => {
    const instance = "p_authz_sideeffect";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "approved",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [], // NO permissions on the skill...
        status: "enabled"
      });
      addInvocation(state, "task_az", skill.id, {
        skill: "approved",
        script: "a.sh",
        ok: true,
        exitCode: 0,
        stdoutBytes: 4,
        stderrBytes: 0
      });
      // ...but the task carried an authorization decision -> consequential.
      addAudit(
        state,
        {
          actor: "user",
          action: "authorization.decided",
          target: "approval_1",
          risk: "high",
          taskId: "task_az"
        },
        { taskId: "task_az" }
      );
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_az", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_az");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.signal).toBe("success");
    // The authorization.* side-effect row promotes this to consequential even
    // though the skill itself declares no permissions.
    expect(outcomes[0]!.consequential).toBe(true);
    expect(outcomes[0]!.selfVerifiable).toBe(false);
  });
});

describe("recordObjectiveOutcomes — robustness (never throws)", () => {
  test("malformed evidence (missing/garbage fields) does not throw and yields a defaulted failure", async () => {
    const instance = "p_malformed";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "garbage",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
      // Evidence missing ok/exitCode and with wrong-typed fields.
      addInvocation(state, "task_g", skill.id, {
        skill: 12345, // wrong type
        script: null, // wrong type
        ok: "yes", // not boolean true
        exitCode: "nope" // not a number
      });
    });
    // Must not throw.
    await recordObjectiveOutcomes(config, makeTask(instance, "task_g", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_g");
    expect(outcomes).toHaveLength(1);
    // ok !== true -> failure; non-numeric exitCode -> undefined.
    expect(outcomes[0]!.signal).toBe("failure");
    expect(outcomes[0]!.exitCode).toBeUndefined();
    // Garbage skill/script names don't survive as strings.
    expect(outcomes[0]!.skillName).not.toBe(12345 as unknown as string);
  });

  test("invocation row with no evidence object does not throw", async () => {
    const instance = "p_no_evidence";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "bare",
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
          risk: "medium",
          taskId: "task_ne"
          // no evidence at all
        },
        { taskId: "task_ne" }
      );
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_ne", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_ne");
    expect(outcomes).toHaveLength(1);
    // No ok evidence -> failure.
    expect(outcomes[0]!.signal).toBe("failure");
  });

  test("invocation with empty-string target is tolerated and stays unattributed-keyed", async () => {
    const instance = "p_empty_target";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      addAudit(
        state,
        {
          actor: "agent",
          action: "skill.script.invoked",
          target: "",
          risk: "medium",
          taskId: "task_et",
          evidence: { skill: "ghost", script: "g.sh", ok: false, exitCode: 1, stdoutBytes: 0, stderrBytes: 1 }
        },
        { taskId: "task_et" }
      );
    });
    await recordObjectiveOutcomes(config, makeTask(instance, "task_et", "completed"));
    const outcomes = readState(instance).skillOutcomes.filter((o) => o.taskId === "task_et");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.signal).toBe("failure");
    // An empty target id resolves to no skill record; skillId is the empty string.
    expect(outcomes[0]!.skillId).toBe("");
  });

  test("invocations for a DIFFERENT task are not mixed into this task's outcomes", async () => {
    const instance = "p_task_isolation";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      const skill = createSkill(state, {
        name: "shared",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
      addInvocation(state, "task_A", skill.id, {
        skill: "shared",
        script: "s.sh",
        ok: false,
        exitCode: 1,
        stdoutBytes: 0,
        stderrBytes: 1,
        stderrSnippet: "A failed"
      });
      addInvocation(state, "task_B", skill.id, {
        skill: "shared",
        script: "s.sh",
        ok: true,
        exitCode: 0,
        stdoutBytes: 1,
        stderrBytes: 0
      });
    });
    // Harvest only task_A.
    await recordObjectiveOutcomes(config, makeTask(instance, "task_A", "completed"));
    const all = readState(instance).skillOutcomes;
    const a = all.filter((o) => o.taskId === "task_A");
    const b = all.filter((o) => o.taskId === "task_B");
    expect(a).toHaveLength(1);
    expect(a[0]!.signal).toBe("failure");
    // task_B's invocation must NOT have produced an outcome (we only harvested A).
    expect(b).toHaveLength(0);
  });
});

describe("recordFeedbackOutcome", () => {
  test("positive feedback is a non-self-verifiable consequential success with no errorDetail", async () => {
    const instance = "p_fb_pos";
    const config = makeConfig(instance);
    await mutateState(instance, (state) => {
      createSkill(state, {
        name: "calendar",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
    });
    const out = await recordFeedbackOutcome(config, {
      skillName: "calendar",
      taskId: "task_fbp",
      ok: true,
      detail: "looked great"
    });
    expect(out.signal).toBe("success");
    expect(out.source).toBe("user_feedback");
    expect(out.consequential).toBe(true);
    expect(out.selfVerifiable).toBe(false);
    expect(out.feedbackPrompted).toBe(true);
    // A positive verdict carries no errorDetail even if detail text was provided.
    expect(out.errorDetail).toBeUndefined();
  });

  test("negative feedback scrubs secrets out of the user's detail", async () => {
    const instance = "p_fb_scrub";
    const config = makeConfig(instance);
    const out = await recordFeedbackOutcome(config, {
      skillId: "skill_unknown",
      taskId: "task_fbs",
      ok: false,
      detail: "you leaked my password: hunter2secret and api_key=abcdef123456"
    });
    expect(out.signal).toBe("failure");
    expect(out.errorDetail).toBeDefined();
    expect(out.errorDetail).not.toContain("hunter2secret");
    expect(out.errorDetail).not.toContain("abcdef123456");
  });

  test("feedback for an unknown skill id is stored verbatim (no fabricated skill record)", async () => {
    const instance = "p_fb_unknown";
    const config = makeConfig(instance);
    readState(instance);
    const out = await recordFeedbackOutcome(config, {
      skillId: "skill_ghost",
      taskId: "task_fbu",
      ok: false,
      detail: "wrong"
    });
    // Unknown id is preserved on the row; no skill record is invented.
    expect(out.skillId).toBe("skill_ghost");
    expect(out.skillName).toBeUndefined();
    expect(readState(instance).skills).toHaveLength(0);
  });
});
