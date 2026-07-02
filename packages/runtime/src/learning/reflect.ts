// Reflection / optimizer pass (ADR skill-learning-from-outcomes.md).
//
// Gathers unreviewed failure outcomes, groups them by skillId, and for each
// skill with >= 2 unreviewed failures makes ONE structured LLM call that
// classifies the failure batch (defectClass) and proposes bounded edits.
// Routing (decision #4 / #6):
//   skill_defect + a USER skill + non-empty edits -> an ImprovementProposal
//     (mode:"edit"), human-gated like any other improvement;
//   skill_defect on a BUNDLED skill                -> a LearningFinding (no disk edit);
//   environment / credential / model_ignored       -> a LearningFinding;
//   transient / unknown                             -> dropped.
// Every processed outcome is marked reviewed:true. Proposals are clipped to
// maxProposals (SkillOpt's edit-budget floor of 2). The prompt forbids
// instance-specific edits — only generalizable procedure.

import type { RuntimeConfig, SkillEditOp, SkillOutcome, SkillRecord } from "../types";
import {
  createLearningFinding,
  mutateState,
  readState,
  readTrace
} from "../state";
import { generateStructured, type StructuredValidator } from "../provider";
import { providerOverrideForRuntime } from "../execution/effective-context";
import { proposeImprovement } from "../governance/improvements";
import { applySkillEdits } from "./edits";
import type { ReflectionVerdict } from "./types";

// >= 2 attributed failures before a skill is optimized (anti-overfit floor).
export const MIN_FAILURES_TO_OPTIMIZE = 2;

const REFLECT_SYSTEM = `You are a skill-optimization analyst for a personal-assistant agent. You are given a skill's markdown body and a batch of failures that occurred when the agent ran that skill's script. Classify the ROOT CAUSE of the batch and, only when the skill's WRITTEN PROCEDURE is at fault, propose bounded edits to the body.

Output strict JSON: {
  "defectClass": "skill_defect" | "environment" | "credential" | "model_ignored" | "transient" | "unknown",
  "attributable": boolean,
  "edits": Array<
    { "op": "append", "content": string } |
    { "op": "insert_after", "anchor": string, "content": string } |
    { "op": "replace", "target": string, "content": string } |
    { "op": "delete", "target": string }
  >,
  "rationale": string,
  "nonSkillFinding": string  // present only when defectClass is not skill_defect
}.

Rules:
- "skill_defect": the body's steps are wrong, ambiguous, or missing a step. ONLY this class warrants edits.
- "environment": a flaky API, a service outage, a missing tool. -> no edits, set nonSkillFinding.
- "credential": an expired/invalid token or missing grant. -> no edits, set nonSkillFinding.
- "model_ignored": the body is fine but the agent didn't follow it / didn't load the skill. -> no edits, set nonSkillFinding flagging trigger clarity.
- "transient" / "unknown": insufficient signal. -> no edits, empty.
- anchor/target strings for insert_after/replace/delete MUST be EXACT substrings of the body.
- Edits MUST be generalizable procedure ONLY. NEVER hard-code instance-specific names, ids, emails, amounts, or values from the failures into the body.
- Keep the edit budget small: at most a few precise edits.`;

// Exported so a test can pin the instance-specific-edit prohibition without
// duplicating the prompt text.
export const REFLECT_SYSTEM_FORBIDS_INSTANCE_EDITS = REFLECT_SYSTEM;

function buildUserPrompt(skill: SkillRecord, failures: SkillOutcome[]): string {
  const failureLines = failures
    .map((f, i) => {
      const parts = [`#${i + 1}`];
      if (f.scriptName) parts.push(`script=${f.scriptName}`);
      if (f.exitCode !== undefined) parts.push(`exit=${f.exitCode}`);
      if (f.source === "user_feedback") parts.push("source=user");
      if (f.errorDetail) parts.push(`detail="${f.errorDetail}"`);
      return parts.join(" ");
    })
    .join("\n");
  return `SKILL NAME: ${skill.name}\nSKILL SOURCE: ${skill.source ?? "user"}\n\nSKILL BODY:\n"""\n${skill.body}\n"""\n\nFAILURES (${failures.length}):\n${failureLines}\n\nClassify the batch and, only for a skill_defect, propose bounded, generalizable edits.`;
}

const DEFECT_CLASSES = [
  "skill_defect",
  "environment",
  "credential",
  "model_ignored",
  "transient",
  "unknown"
] as const;

const EDIT_OPS = ["append", "insert_after", "replace", "delete"] as const;

function parseEdit(value: unknown): SkillEditOp | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const op = obj.op;
  if (typeof op !== "string" || !(EDIT_OPS as readonly string[]).includes(op)) return null;
  const content = typeof obj.content === "string" ? obj.content : "";
  if (op === "append") {
    if (!content) return null;
    return { op: "append", content };
  }
  if (op === "insert_after") {
    const anchor = typeof obj.anchor === "string" ? obj.anchor : "";
    if (!anchor || !content) return null;
    return { op: "insert_after", anchor, content };
  }
  if (op === "replace") {
    const target = typeof obj.target === "string" ? obj.target : "";
    if (!target) return null;
    return { op: "replace", target, content };
  }
  // delete
  const target = typeof obj.target === "string" ? obj.target : "";
  if (!target) return null;
  return { op: "delete", target };
}

export const reflectionValidator: StructuredValidator<ReflectionVerdict> = {
  parse(value: unknown): ReflectionVerdict {
    const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const defectClass = (DEFECT_CLASSES as readonly string[]).includes(obj.defectClass as string)
      ? (obj.defectClass as ReflectionVerdict["defectClass"])
      : "unknown";
    const edits = Array.isArray(obj.edits)
      ? obj.edits.map(parseEdit).filter((e): e is SkillEditOp => e !== null)
      : [];
    return {
      defectClass,
      attributable: obj.attributable === true,
      edits,
      rationale: typeof obj.rationale === "string" ? obj.rationale : "",
      nonSkillFinding: typeof obj.nonSkillFinding === "string" ? obj.nonSkillFinding : undefined
    };
  }
};

export interface ReflectResult {
  proposalsCreated: number;
  findingsCreated: number;
  outcomesReviewed: number;
}

export interface ReflectOptions {
  agentId?: string;
  maxProposals?: number;
}

export async function reflectOnSkillOutcomes(
  config: RuntimeConfig,
  options: ReflectOptions = {}
): Promise<ReflectResult> {
  const maxProposals = options.maxProposals ?? 2;
  const state = readState(config.instance);

  // Unreviewed objective + feedback failures that are attributed to a skill.
  const failures = state.skillOutcomes.filter(
    (o) =>
      o.signal === "failure" &&
      !o.reviewed &&
      Boolean(o.skillId) &&
      (options.agentId === undefined || o.agentId === options.agentId)
  );

  // Group by skillId.
  const bySkill = new Map<string, SkillOutcome[]>();
  for (const f of failures) {
    const list = bySkill.get(f.skillId!) ?? [];
    list.push(f);
    bySkill.set(f.skillId!, list);
  }

  // Provider resolved from the ACTIVE agent, not each outcome's agentId — a
  // multi-agent batch can therefore reflect under a different agent's provider
  // than the one that produced the failure (acceptable in v1; left as-is).
  const providerOverride = providerOverrideForRuntime(config);
  let proposalsCreated = 0;
  let findingsCreated = 0;
  // Each reviewed row carries the batch's classification so it is persisted on
  // the outcome (not discarded) — a defectClass-aware reliability score and the
  // over-time view depend on knowing which failures the skill actually owns.
  const reviewedRows: Array<{
    id: string;
    defectClass?: ReflectionVerdict["defectClass"];
    attributable?: boolean;
  }> = [];

  for (const [skillId, batch] of bySkill) {
    // Anti-overfit floor: a skill needs >= 2 attributed failures.
    if (batch.length < MIN_FAILURES_TO_OPTIMIZE) continue;
    const skill = state.skills.find((s) => s.id === skillId);
    if (!skill) {
      // The skill is gone — mark the outcomes reviewed so they don't linger
      // (no verdict was computed, so no classification to stamp).
      reviewedRows.push(...batch.map((b) => ({ id: b.id })));
      continue;
    }

    let verdict: ReflectionVerdict;
    try {
      const result = await generateStructured(
        config,
        {
          system: REFLECT_SYSTEM,
          user: buildUserPrompt(skill, batch),
          schemaName: "SkillReflection",
          validator: reflectionValidator,
          echoTag: `skill-reflect:${skillId}`
        },
        providerOverride
      );
      verdict = result.data;
    } catch {
      // A failed reflection leaves the batch unreviewed for the next pass.
      continue;
    }

    const sourceTaskIds = [...new Set(batch.map((b) => b.taskId))];
    const source = skill.source ?? "user";

    // A user-skill defect with edits that actually apply to the current body is
    // a real, actionable proposal candidate.
    const isUserSkill = source === "user" && Boolean(skill.manifestPath);
    const candidate =
      verdict.defectClass === "skill_defect" && isUserSkill && verdict.edits.length > 0
        ? applySkillEdits(skill.body, verdict.edits)
        : undefined;
    const actionableUserEdit = candidate !== undefined && candidate.applied > 0;

    if (actionableUserEdit && proposalsCreated >= maxProposals) {
      // Clipped by the edit budget. Do NOT fall through to a finding (this is
      // not a bundled/non-editable skill) and do NOT mark the batch reviewed —
      // leave it for a later pass so the real defect isn't lost to the clip.
      continue;
    }

    // The batch is being processed (proposed, routed to a finding, or dropped)
    // — mark it reviewed so a later pass doesn't re-reflect it, and persist the
    // verdict's classification onto each row.
    reviewedRows.push(
      ...batch.map((b) => ({
        id: b.id,
        defectClass: verdict.defectClass,
        attributable: verdict.attributable
      }))
    );

    if (verdict.defectClass === "skill_defect") {
      if (actionableUserEdit) {
        // Trace ids are the evidence pointer (sourceTaskId stays the primary
        // pointer); use the source task's last-few trace ids, or [] if none.
        const sourceTraceIds = readTrace(config.instance, sourceTaskIds[0]!)
          .slice(-5)
          .map((t) => t.id);
        await proposeImprovement(config, {
          kind: "skill",
          title: `Improve skill: ${skill.name}`,
          rationale: verdict.rationale || `Recurring failures running ${skill.name}.`,
          sourceTaskId: sourceTaskIds[0],
          sourceTraceIds,
          payload: {
            mode: "edit",
            targetSkillId: skill.id,
            baseVersion: skill.version,
            baseBody: skill.body,
            edits: verdict.edits,
            candidateBody: candidate!.body
          }
        });
        proposalsCreated += 1;
        continue;
      }
      // A skill_defect on a bundled (or otherwise non-editable) skill, or one
      // with no actionable edits, becomes a finding pointing at the source.
      await mutateState(config.instance, (s) => {
        createLearningFinding(s, {
          agentId: options.agentId,
          skillId: skill.id,
          skillName: skill.name,
          kind: "bundled_skill",
          summary:
            source === "bundled"
              ? `Recurring failures in bundled skill "${skill.name}" — ${verdict.rationale || "needs a repo fix."}`
              : `Recurring failures in skill "${skill.name}" — ${verdict.rationale || "needs review."}`,
          sourceTaskIds
        });
      });
      findingsCreated += 1;
      continue;
    }

    if (
      verdict.defectClass === "environment" ||
      verdict.defectClass === "credential" ||
      verdict.defectClass === "model_ignored"
    ) {
      await mutateState(config.instance, (s) => {
        createLearningFinding(s, {
          agentId: options.agentId,
          skillId: skill.id,
          skillName: skill.name,
          kind: verdict.defectClass as "environment" | "credential" | "model_ignored",
          summary: verdict.nonSkillFinding || verdict.rationale || `${verdict.defectClass} issue with ${skill.name}.`,
          sourceTaskIds
        });
      });
      findingsCreated += 1;
      continue;
    }

    // transient / unknown -> dropped (outcomes already marked reviewed).
  }

  if (reviewedRows.length > 0) {
    await markReviewed(config, reviewedRows);
  }

  return { proposalsCreated, findingsCreated, outcomesReviewed: reviewedRows.length };
}

async function markReviewed(
  config: RuntimeConfig,
  rows: Array<{ id: string; defectClass?: ReflectionVerdict["defectClass"]; attributable?: boolean }>
): Promise<void> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  await mutateState(config.instance, (state) => {
    for (const outcome of state.skillOutcomes) {
      const row = byId.get(outcome.id);
      if (!row) continue;
      outcome.reviewed = true;
      // Persist the classification we already paid an LLM to compute, so the
      // score can exclude non-skill failures instead of discarding the verdict.
      if (row.defectClass !== undefined) outcome.defectClass = row.defectClass;
      if (row.attributable !== undefined) outcome.attributable = row.attributable;
    }
  });
}
