// Objective outcome harvesting (ADR skill-learning-from-outcomes.md, tier 1).
//
// At task terminal, read the task's already-persisted `skill.script.invoked`
// audit rows + task.status and write one SkillOutcome per script invocation
// (failure when ok:false / non-zero exit, else success), attributed to the
// skill via the audit row's `target`. A `failed` task with no script
// invocation yields one unattributed (skillId unset) failure row for the
// digest's "what didn't work" summary only. Error text is scrubbed and capped.
//
// This only reads + appends a bounded array, so it adds negligible
// terminal-path cost and must NEVER throw into the task (callers invoke it
// fire-and-forget alongside scheduleAutoRetain).

import type { AuditEvent, RuntimeConfig, SkillRecord, Task } from "../types";
import { createSkillOutcome, mutateState } from "../state";
import { redactSecrets } from "../provider";

const ERROR_DETAIL_CAP = 500;

function scrubError(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  return redactSecrets(detail).slice(0, ERROR_DETAIL_CAP);
}

// A task is "consequential" when an attributed skill declares
// requiredPermissions OR the task carried an approval / side-effecting audit
// row (an authorization request/decision or a messaging send).
function taskCarriedSideEffect(audit: AuditEvent[], taskId: string): boolean {
  return audit.some(
    (row) =>
      row.taskId === taskId &&
      (row.action.startsWith("authorization.") || row.action.startsWith("messaging."))
  );
}

function isConsequential(skill: SkillRecord | undefined, sideEffect: boolean): boolean {
  if (sideEffect) return true;
  return Boolean(skill && skill.requiredPermissions.length > 0);
}

// Harvest objective outcomes for a terminal task. Fire-and-forget; swallows
// every error so it can never destabilize the task-completion path.
export async function recordObjectiveOutcomes(config: RuntimeConfig, task: Task): Promise<void> {
  try {
    await mutateState(config.instance, (state) => {
      const invocations = state.audit.filter(
        (row) => row.action === "skill.script.invoked" && row.taskId === task.id
      );
      const sideEffect = taskCarriedSideEffect(state.audit, task.id);

      // A failed task with no skill script yields one unattributed failure row
      // for the digest's summary only, never a skill edit.
      if (invocations.length === 0 && task.status === "failed") {
        createSkillOutcome(state, {
          taskId: task.id,
          agentId: task.agentId,
          signal: "failure",
          source: "objective",
          errorDetail: scrubError(task.error),
          consequential: false,
          // A terminal failed status is itself an objective signal.
          selfVerifiable: true,
          reviewed: false,
          feedbackPrompted: false
        });
        return;
      }

      // Collapse multiple invocations of the SAME skill within ONE task into a
      // single outcome. A task is one trajectory, so a retry loop must not
      // inflate the per-skill failure count that gates reflection's
      // ≥2-distinct-trajectory floor (ADR skill-learning-from-outcomes.md): the
      // skill's outcome for this task is a failure if ANY of its invocations
      // failed, and the representative exit/script comes from the first failure.
      const bySkill = new Map<
        string,
        { failed: boolean; exitCode?: number; skillName?: string; scriptName?: string; detail?: string }
      >();
      for (const row of invocations) {
        const evidence = (row.evidence ?? {}) as Record<string, unknown>;
        const ok = evidence.ok === true;
        const exitCode = typeof evidence.exitCode === "number" ? evidence.exitCode : undefined;
        const failed = !(ok && (exitCode === undefined || exitCode === 0));
        const skillName = typeof evidence.skill === "string" ? evidence.skill : undefined;
        const scriptName = typeof evidence.script === "string" ? evidence.script : undefined;
        // skill-scripts.ts persists a scrubbed failure reason on the audit row.
        const snippet = typeof evidence.stderrSnippet === "string" ? evidence.stderrSnippet : undefined;
        // `target` on the row is the skill id (see skill-scripts.ts).
        const prior = bySkill.get(row.target);
        if (!prior) {
          bySkill.set(row.target, {
            failed,
            exitCode: failed ? exitCode : undefined,
            skillName,
            scriptName,
            detail: failed ? snippet : undefined
          });
        } else if (failed && !prior.failed) {
          // First failure for this skill wins the representative detail.
          prior.failed = true;
          prior.exitCode = exitCode;
          prior.scriptName = scriptName ?? prior.scriptName;
          prior.detail = snippet;
        }
      }

      for (const [skillId, agg] of bySkill) {
        const skill = state.skills.find((s) => s.id === skillId);
        const signal = agg.failed ? "failure" : "success";
        const consequential = isConsequential(skill, sideEffect);
        createSkillOutcome(state, {
          taskId: task.id,
          agentId: task.agentId,
          skillId,
          skillName: agg.skillName ?? skill?.name,
          scriptName: agg.scriptName,
          signal,
          source: "objective",
          exitCode: agg.exitCode,
          // A failure's detail is the scrubbed reason persisted on the script
          // audit row (so the classifier can tell environment from skill defect),
          // falling back to the task error when the task itself failed. Re-scrub
          // here so the capture layer is self-protecting (defense in depth) and
          // never depends solely on the producer having redacted the snippet.
          errorDetail: signal === "failure" ? scrubError(agg.detail ?? task.error) : undefined,
          consequential,
          // A failure's terminal/exit status is an objective signal, but a
          // consequential success only proves the action EXECUTED, not that it
          // was correct — so it is NOT self-verifiable. selfVerifiable =
          // !consequential for success rows.
          selfVerifiable: signal === "failure" ? true : !consequential,
          reviewed: false,
          feedbackPrompted: false
        });
      }

      // A non-failed completion that carried a side effect (an approval /
      // messaging send) but ran NO attributed skill script is a consequential
      // action with no objective correctness check — the tier-2 population the
      // daily review samples for human feedback. When a script DID run (success
      // OR failure), the per-skill loop above already recorded its outcome, so a
      // fallback row here would double-count — and on a FAILED script it would
      // contradict the recorded failure with a phantom success. A non-script side
      // effect can't be attributed to any one skill, so the sample is unattributed.
      if (task.status !== "failed" && sideEffect && invocations.length === 0) {
        createSkillOutcome(state, {
          taskId: task.id,
          agentId: task.agentId,
          signal: "success",
          source: "objective",
          consequential: true,
          selfVerifiable: false,
          reviewed: false,
          feedbackPrompted: false
        });
      }
    });
  } catch {
    // Best-effort harvesting — never propagate into the task path.
  }
}

export interface FeedbackInput {
  // The skill the question was about. Either an id or a name resolves it.
  skillId?: string;
  skillName?: string;
  // The task whose action the user is adjudicating.
  taskId: string;
  agentId?: string;
  // The user's verdict: did the action turn out right?
  ok: boolean;
  // Optional free-text the user gave; scrubbed + capped into errorDetail on a
  // negative verdict.
  detail?: string;
}

// Tier 2: record the user's answer to a review question as a SkillOutcome with
// source:"user_feedback" (ADR skill-learning-from-outcomes.md). A negative
// answer becomes a failure attributed to the named skill so the next review
// reflects on it; a positive answer is a non-self-verifiable success.
export async function recordFeedbackOutcome(config: RuntimeConfig, input: FeedbackInput) {
  return mutateState(config.instance, (state) => {
    const skill = input.skillId
      ? state.skills.find((s) => s.id === input.skillId)
      : input.skillName
        ? state.skills.find((s) => s.name === input.skillName)
        : undefined;
    return createSkillOutcome(state, {
      taskId: input.taskId,
      agentId: input.agentId,
      skillId: skill?.id ?? input.skillId,
      skillName: skill?.name ?? input.skillName,
      signal: input.ok ? "success" : "failure",
      source: "user_feedback",
      errorDetail: input.ok ? undefined : scrubError(input.detail),
      // The user adjudicated a consequential action — that's the only reason
      // it was sampled for feedback.
      consequential: true,
      // Human feedback fills exactly the gap objective signals can't verify.
      selfVerifiable: false,
      reviewed: false,
      feedbackPrompted: true
    });
  });
}
