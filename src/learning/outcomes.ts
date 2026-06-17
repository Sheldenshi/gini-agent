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

      if (invocations.length === 0) {
        // No skill script ran. Only a failed task produces a row here — an
        // unattributed failure for the digest's summary, never a skill edit.
        if (task.status !== "failed") return;
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

      for (const row of invocations) {
        const evidence = (row.evidence ?? {}) as Record<string, unknown>;
        const ok = evidence.ok === true;
        const exitCode = typeof evidence.exitCode === "number" ? evidence.exitCode : undefined;
        const skillName = typeof evidence.skill === "string" ? evidence.skill : undefined;
        const scriptName = typeof evidence.script === "string" ? evidence.script : undefined;
        // `target` on the row is the skill id (see skill-scripts.ts).
        const skill = state.skills.find((s) => s.id === row.target);
        const signal = ok && (exitCode === undefined || exitCode === 0) ? "success" : "failure";
        createSkillOutcome(state, {
          taskId: task.id,
          agentId: task.agentId,
          skillId: row.target,
          skillName: skillName ?? skill?.name,
          scriptName,
          signal,
          source: "objective",
          exitCode,
          // Only failures carry detail. The audit row doesn't store stderr text
          // (only byte counts), so a script failure's detail comes from the
          // task error when the task itself failed; otherwise it's left unset
          // and the script's exit code/name is the signal.
          errorDetail: signal === "failure" ? scrubError(task.error) : undefined,
          consequential: isConsequential(skill, sideEffect),
          // A script ok/exit is an objective signal.
          selfVerifiable: true,
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
