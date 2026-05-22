import type { RuntimeConfig } from "../types";
import { addAudit, createImprovementProposal, createJob, createSkill, mutateState, now, readState, readTrace } from "../state";

export async function proposeImprovement(config: RuntimeConfig, input: Record<string, unknown>) {
  const taskId = typeof input.sourceTaskId === "string" ? input.sourceTaskId : undefined;
  const trace = taskId ? readTrace(config.instance, taskId) : [];
  // The "memory" improvement kind was removed alongside the
  // state.memories consolidation (see ADR runtime-identity-files.md).
  // Skill and job stay; anything else defaults to skill so a legacy
  // payload doesn't crash but lands on the skill creation path.
  const kind = input.kind === "job" ? "job" : "skill";
  const title = String(input.title ?? `${kind} improvement`);
  const payload = normalizeImprovementPayload(kind, input.payload);

  return mutateState(config.instance, (state) => createImprovementProposal(state, {
    kind,
    title,
    rationale: String(input.rationale ?? "Proposed from runtime evidence."),
    sourceTaskId: taskId,
    sourceTraceIds: Array.isArray(input.sourceTraceIds)
      ? input.sourceTraceIds.map(String)
      : trace.slice(-5).map((item) => item.id),
    payload
  }));
}

export async function reviewImprovement(config: RuntimeConfig, proposalId: string, decision: "approve" | "reject") {
  return mutateState(config.instance, (state) => {
    const proposal = state.improvements.find((candidate) => candidate.id === proposalId);
    if (!proposal) throw new Error(`Improvement proposal not found: ${proposalId}`);
    if (proposal.status !== "proposed" && proposal.status !== "approved") {
      throw new Error(`Improvement proposal is already ${proposal.status}`);
    }

    if (decision === "reject") {
      proposal.status = "rejected";
      proposal.updatedAt = now();
      addAudit(
        state,
        {
          actor: "user",
          action: "improvement.rejected",
          target: proposal.id,
          risk: "medium",
          taskId: proposal.sourceTaskId
        },
        proposal.sourceTaskId ? { taskId: proposal.sourceTaskId } : { system: true }
      );
      return proposal;
    }

    proposal.status = "approved";
    proposal.updatedAt = now();
    const appliedTargetId = applyImprovement(state, proposal);
    proposal.appliedTargetId = appliedTargetId;
    proposal.status = "applied";
    proposal.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "improvement.applied",
        target: proposal.id,
        risk: "medium",
        taskId: proposal.sourceTaskId,
        evidence: { kind: proposal.kind, appliedTargetId }
      },
      proposal.sourceTaskId ? { taskId: proposal.sourceTaskId } : { system: true }
    );
    return proposal;
  });
}

function applyImprovement(state: ReturnType<typeof readState>, proposal: Awaited<ReturnType<typeof proposeImprovement>>): string {
  if (proposal.kind === "skill") {
    const skill = createSkill(state, {
      name: String(proposal.payload.name ?? proposal.title),
      description: String(proposal.payload.description ?? proposal.rationale),
      trigger: String(proposal.payload.trigger ?? proposal.payload.name ?? proposal.title),
      steps: Array.isArray(proposal.payload.steps) ? proposal.payload.steps.map(String) : [proposal.rationale],
      requiredTools: Array.isArray(proposal.payload.requiredTools) ? proposal.payload.requiredTools.map(String) : [],
      requiredPermissions: Array.isArray(proposal.payload.requiredPermissions) ? proposal.payload.requiredPermissions.map(String) : [],
      status: proposal.payload.status === "disabled" ? "disabled" : "enabled"
    });
    return skill.id;
  }

  const intervalSeconds = Math.max(1, Number(proposal.payload.intervalSeconds ?? 3600));
  // Carry the originating task's owning agent onto the created job so the
  // first scheduler fire doesn't reattribute it to whatever happens to be
  // active right now. Falls back to state.activeAgentId when the proposal
  // pre-dates per-agent stamping.
  const sourceTask = proposal.sourceTaskId
    ? state.tasks.find((task) => task.id === proposal.sourceTaskId)
    : undefined;
  const agentId = sourceTask?.agentId ?? state.activeAgentId;
  const job = createJob(state, {
    name: String(proposal.payload.name ?? proposal.title),
    prompt: String(proposal.payload.prompt ?? proposal.rationale),
    intervalSeconds,
    nextRunAt: new Date(Date.now() + intervalSeconds * 1000).toISOString(),
    agentId
  });
  return job.id;
}

function normalizeImprovementPayload(kind: "skill" | "job", payload: unknown): Record<string, unknown> {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (kind === "skill") return { name: String(value.name ?? "Draft skill"), steps: Array.isArray(value.steps) ? value.steps : [], ...value };
  return { name: String(value.name ?? "Suggested job"), prompt: String(value.prompt ?? ""), ...value };
}
