import type { RuntimeConfig } from "../types";
import { addAudit, createImprovementProposal, createJob, createMemory, createSkill, mutateState, now, readState, readTrace } from "../state";

export async function proposeImprovement(config: RuntimeConfig, input: Record<string, unknown>) {
  const taskId = typeof input.sourceTaskId === "string" ? input.sourceTaskId : undefined;
  const trace = taskId ? readTrace(config.instance, taskId) : [];
  const kind = input.kind === "skill" || input.kind === "job" ? input.kind : "memory";
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
      addAudit(state, {
        actor: "user",
        action: "improvement.rejected",
        target: proposal.id,
        risk: "medium",
        taskId: proposal.sourceTaskId
      });
      return proposal;
    }

    proposal.status = "approved";
    proposal.updatedAt = now();
    const appliedTargetId = applyImprovement(state, proposal);
    proposal.appliedTargetId = appliedTargetId;
    proposal.status = "applied";
    proposal.updatedAt = now();
    addAudit(state, {
      actor: "user",
      action: "improvement.applied",
      target: proposal.id,
      risk: "medium",
      taskId: proposal.sourceTaskId,
      evidence: { kind: proposal.kind, appliedTargetId }
    });
    return proposal;
  });
}

function applyImprovement(state: ReturnType<typeof readState>, proposal: Awaited<ReturnType<typeof proposeImprovement>>): string {
  if (proposal.kind === "memory") {
    const memory = createMemory(state, {
      content: String(proposal.payload.content ?? proposal.title),
      sourceTaskId: proposal.sourceTaskId,
      confidence: Number(proposal.payload.confidence ?? 0.75),
      status: "active",
      sensitivity: proposal.payload.sensitivity === "sensitive" ? "sensitive" : "normal",
      provenance: `Applied improvement ${proposal.id}`
    });
    return memory.id;
  }

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
  const job = createJob(state, {
    name: String(proposal.payload.name ?? proposal.title),
    prompt: String(proposal.payload.prompt ?? proposal.rationale),
    intervalSeconds,
    nextRunAt: new Date(Date.now() + intervalSeconds * 1000).toISOString()
  });
  return job.id;
}

function normalizeImprovementPayload(kind: "memory" | "skill" | "job", payload: unknown): Record<string, unknown> {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (kind === "memory") return { content: String(value.content ?? ""), ...value };
  if (kind === "skill") return { name: String(value.name ?? "Draft skill"), steps: Array.isArray(value.steps) ? value.steps : [], ...value };
  return { name: String(value.name ?? "Suggested job"), prompt: String(value.prompt ?? ""), ...value };
}
