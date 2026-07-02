import { readFileSync } from "node:fs";
import type { ImprovementProposal, RuntimeConfig, SkillEditOp } from "../types";
import { addAudit, createImprovementProposal, createJob, createSkill, mutateState, now, readState, readTrace } from "../state";
import { installSkillFromBody } from "../capabilities/skills";
import { applySkillEdits } from "../learning/edits";

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
  // Approving a skill-EDIT proposal must rewrite the on-disk SKILL.md via the
  // async installSkillFromBody path (which runs its own mutateState + reload).
  // applyImprovement runs SYNCHRONOUSLY inside mutateState, so it can't await
  // that. We resolve this by handling the edit-apply OUTSIDE the state
  // transaction in this function: the async skill write happens first, then a
  // single mutateState flips the proposal proposed -> approved -> applied and
  // writes the improvement.applied audit. This keeps approve->applied coherent
  // (the status flips only after the write succeeds — a failed install leaves
  // the proposal un-applied) and keeps the legacy create/job paths unchanged
  // (they stay sync inside mutateState via applyImprovement).
  const editApply = await maybeApplySkillEditOutsideTransaction(config, proposalId, decision);
  if (editApply) return editApply;

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

// When the proposal is an APPROVE of a skill-edit (mode:"edit") proposal,
// perform the async on-disk rewrite here and flip status in a follow-up
// transaction. Returns the updated proposal, or undefined when this isn't an
// approved skill-edit (so the caller falls through to the sync path — including
// REJECT of an edit proposal, which needs no disk write).
//
// Single-flight + atomic against a concurrent double-approve: the proposal is
// CLAIMED under a lock (`proposed` -> `approved`) before the async install, so
// a second concurrent approve sees `approved`/`applied` and bails instead of
// re-applying the edits to the already-edited file (e.g. a double-append) and
// double-emitting `improvement.applied`. The async `installSkillFromBody` runs
// outside the lock; a final transaction re-checks the claim, flips to
// `applied`, and audits exactly once. A failed install RELEASES the claim back
// to `proposed` so a retry can re-approve.
async function maybeApplySkillEditOutsideTransaction(
  config: RuntimeConfig,
  proposalId: string,
  decision: "approve" | "reject"
): Promise<ImprovementProposal | undefined> {
  if (decision !== "approve") return undefined;
  const peek = readState(config.instance).improvements.find((p) => p.id === proposalId);
  if (!peek) throw new Error(`Improvement proposal not found: ${proposalId}`);
  if (peek.kind !== "skill" || peek.payload.mode !== "edit") return undefined;

  // Claim under the lock: require `proposed` and flip to `approved` atomically
  // so only one approver proceeds. A concurrent approver finds a non-`proposed`
  // status and throws `already approved`/`already applied`.
  const claimed = await mutateState(config.instance, (state) => {
    const live = state.improvements.find((p) => p.id === proposalId);
    if (!live) throw new Error(`Improvement proposal not found: ${proposalId}`);
    if (live.status !== "proposed") {
      throw new Error(`Improvement proposal is already ${live.status}`);
    }
    live.status = "approved";
    live.updatedAt = now();
    return live;
  });

  const targetSkillId = String(claimed.payload.targetSkillId ?? "");
  const skill = readState(config.instance).skills.find((s) => s.id === targetSkillId);
  // From here on, a thrown error must RELEASE the claim so the proposal is
  // re-approvable; releaseClaim restores `proposed` then rethrows.
  if (!skill) {
    await releaseClaim(config, proposalId);
    throw new Error(`Skill edit target not found: ${targetSkillId}`);
  }
  // Bundled / legacy skills are never rewritten on disk (decision #6): a
  // recurring failure there is a finding, not an auto-edit. Refuse loudly so
  // the reviewer sees why.
  if ((skill.source ?? "user") !== "user" || !skill.manifestPath) {
    await releaseClaim(config, proposalId);
    throw new Error(
      `Cannot edit skill ${skill.name}: only user skills with an on-disk SKILL.md are editable (bundled/legacy skills are propose-only).`
    );
  }

  const edits = Array.isArray(claimed.payload.edits) ? (claimed.payload.edits as SkillEditOp[]) : [];
  let result: ReturnType<typeof applySkillEdits>;
  let installed: Awaited<ReturnType<typeof installSkillFromBody>>;
  try {
    // Rebuild from the CURRENT file on disk (not the proposal's snapshot) so the
    // edit applies to live content; split off the frontmatter, edit the body,
    // reassemble with the original frontmatter header intact.
    const fileText = readFileSync(skill.manifestPath, "utf8");
    const { header, body } = splitSkillFile(fileText);
    result = applySkillEdits(body, edits);
    // A fully-stale proposal (no op matched — the skill body changed since the
    // proposal was generated, per `baseVersion`) would otherwise write the file
    // back unchanged and flip to `applied`. Refuse it so a no-op never masquerades
    // as an applied edit; the reviewer re-generates against the current body.
    if (result.applied === 0) {
      throw new Error(
        `Cannot apply skill edit for ${skill.name}: the skill changed since this proposal was generated; please re-review.`
      );
    }
    const rebuilt = `${header}${result.body.endsWith("\n") ? result.body : `${result.body}\n`}`;
    installed = await installSkillFromBody(config, { body: rebuilt });
  } catch (error) {
    await releaseClaim(config, proposalId);
    throw error;
  }

  return mutateState(config.instance, (state) => {
    const live = state.improvements.find((p) => p.id === proposalId);
    if (!live) throw new Error(`Improvement proposal not found: ${proposalId}`);
    // Re-check the claim is still ours. If a concurrent path already finalized
    // it (applied) or it was rejected, return without re-auditing.
    if (live.status !== "approved") return live;
    live.status = "applied";
    live.appliedTargetId = installed.skill.id;
    live.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "improvement.applied",
        target: live.id,
        risk: "medium",
        taskId: live.sourceTaskId,
        evidence: { kind: live.kind, appliedTargetId: installed.skill.id, mode: "edit", applied: result.applied, skipped: result.skipped.length }
      },
      live.sourceTaskId ? { taskId: live.sourceTaskId } : { system: true }
    );
    return live;
  });
}

// Release a claimed (status:"approved") edit proposal back to "proposed" so a
// later approve can retry. Only releases when still "approved" — never clobbers
// a status a concurrent path already advanced.
async function releaseClaim(config: RuntimeConfig, proposalId: string): Promise<void> {
  await mutateState(config.instance, (state) => {
    const live = state.improvements.find((p) => p.id === proposalId);
    if (live && live.status === "approved") {
      live.status = "proposed";
      live.updatedAt = now();
    }
  });
}

// Split a SKILL.md into (header, body) where `header` is the original
// frontmatter region INCLUDING the surrounding `---` delimiters and the blank
// line that follows, so the body can be edited and reassembled byte-faithfully
// to the original frontmatter. Falls back to an empty header (whole file is
// body) when there's no frontmatter.
function splitSkillFile(text: string): { header: string; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { header: "", body: normalized };
  const after = normalized.slice(3);
  const closeMatch = after.match(/^([\s\S]*?)\n---[ \t]*\n?/);
  if (!closeMatch) return { header: "", body: normalized };
  const headerLen = 3 + closeMatch[0].length;
  let header = normalized.slice(0, headerLen);
  let body = normalized.slice(headerLen);
  // Preserve a single blank line between frontmatter and body if the original
  // had one; otherwise leave the body as-is.
  if (body.startsWith("\n")) {
    header += "\n";
    body = body.slice(1);
  }
  return { header, body };
}

// Revert an applied skill-edit proposal by re-installing its stored baseBody
// (decision #6: approval stores the prior SKILL.md body so a regret is one
// revert away). Only valid for an applied mode:"edit" skill proposal whose
// target is still a user skill with a manifest. Audited as improvement.reverted.
export async function revertImprovement(config: RuntimeConfig, proposalId: string): Promise<ImprovementProposal> {
  const proposal = readState(config.instance).improvements.find((p) => p.id === proposalId);
  if (!proposal) throw new Error(`Improvement proposal not found: ${proposalId}`);
  if (proposal.kind !== "skill" || proposal.payload.mode !== "edit") {
    throw new Error("Only skill-edit proposals can be reverted via this path.");
  }
  if (proposal.status !== "applied") {
    throw new Error(`Improvement proposal is not applied (status: ${proposal.status}).`);
  }
  const baseBody = typeof proposal.payload.baseBody === "string" ? proposal.payload.baseBody : "";
  if (!baseBody.trim()) throw new Error("Proposal has no baseBody to revert to.");
  const targetSkillId =
    typeof proposal.payload.targetSkillId === "string" ? proposal.payload.targetSkillId : undefined;
  const skill = targetSkillId
    ? readState(config.instance).skills.find((s) => s.id === targetSkillId)
    : undefined;
  if (!skill || (skill.source ?? "user") !== "user" || !skill.manifestPath) {
    throw new Error("Revert target is not an editable user skill.");
  }
  // `baseBody` is the frontmatter-STRIPPED SkillRecord.body (what the apply path
  // snapshots). installSkillFromBody requires a FULL SKILL.md, so reassemble the
  // base body under the skill's current frontmatter — exactly the shape the apply
  // path writes — before re-installing. Without this, revert throws on the
  // missing `name` frontmatter and the "one revert away" promise is dead.
  const { header } = splitSkillFile(readFileSync(skill.manifestPath, "utf8"));
  const rebuilt = `${header}${baseBody.endsWith("\n") ? baseBody : `${baseBody}\n`}`;
  const installed = await installSkillFromBody(config, { body: rebuilt });
  return mutateState(config.instance, (state) => {
    const live = state.improvements.find((p) => p.id === proposalId);
    if (!live) throw new Error(`Improvement proposal not found: ${proposalId}`);
    live.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "improvement.reverted",
        target: live.id,
        risk: "medium",
        taskId: live.sourceTaskId,
        evidence: { appliedTargetId: installed.skill.id }
      },
      live.sourceTaskId ? { taskId: live.sourceTaskId } : { system: true }
    );
    return live;
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
  // A skill-EDIT payload (mode:"edit") carries its own fields (targetSkillId,
  // baseVersion, baseBody, edits, candidateBody); the create-only defaults
  // (name/steps) don't apply, so pass it through untouched. The spread already
  // preserves the edit fields, but skipping the defaults keeps the payload clean.
  if (kind === "skill" && value.mode === "edit") return { ...value };
  if (kind === "skill") return { name: String(value.name ?? "Draft skill"), steps: Array.isArray(value.steps) ? value.steps : [], ...value };
  return { name: String(value.name ?? "Suggested job"), prompt: String(value.prompt ?? ""), ...value };
}
