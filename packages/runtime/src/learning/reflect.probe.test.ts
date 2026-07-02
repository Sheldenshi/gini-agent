// Adversarial probe of the reflection/optimizer routing (ADR
// skill-learning-from-outcomes.md). Pins every routing branch
// (skill_defect+user+edits -> proposal; skill_defect+bundled -> finding;
// environment/credential/model_ignored -> finding; transient/unknown ->
// dropped-but-reviewed), the >=2 floor, the maxProposals clip, a skill deleted
// between capture and reflect, an LLM error leaving the batch unreviewed, the
// non-applying-edit -> no-proposal case, and the persistence of defectClass +
// attributable onto consumed outcomes for findings AND proposals AND dropped
// batches. Hermetic: echo provider, unique GINI_STATE_ROOT containing the slice
// name so parallel probers don't collide.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSkill, mutateState, readState, appendTrace } from "../state";
import { createSkillOutcome } from "../state/records";
import { clearEchoStructuredResponses, setEchoStructuredResponse } from "../provider";
import { reloadSkills } from "../capabilities/skills";
import { reflectOnSkillOutcomes } from "./reflect";
import type { RuntimeConfig } from "../types";

const ROOT = "/tmp/gini-reflect-classify-probe";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  clearEchoStructuredResponses();
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

const USER_SKILL_BODY = `---
name: payer
description: Pay invoices
---

# Payer

1. Open the invoice.
2. Click Pay.
`;

function writeUserSkill(instance: string, name: string, body: string): void {
  const dir = join(ROOT, "instances", instance, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

// Seed `count` distinct-task failures attributed to a skill. Distinct taskIds
// are important: the proposal's sourceTaskId is derived from the batch's taskIds
// and findings carry the full set.
async function seedFailures(
  instance: string,
  skillId: string,
  count: number,
  opts: { taskPrefix?: string; agentId?: string } = {}
): Promise<string[]> {
  const taskIds: string[] = [];
  await mutateState(instance, (state) => {
    for (let i = 0; i < count; i++) {
      const taskId = `${opts.taskPrefix ?? "task"}_${skillId}_${i}`;
      taskIds.push(taskId);
      createSkillOutcome(state, {
        taskId,
        agentId: opts.agentId,
        skillId,
        skillName: "payer",
        scriptName: "pay.sh",
        signal: "failure",
        source: "objective",
        exitCode: 1,
        consequential: true,
        selfVerifiable: true,
        reviewed: false,
        feedbackPrompted: false
      });
    }
  });
  return taskIds;
}

// Create an on-disk USER skill (has a manifestPath, source defaults to user),
// the only shape that routes a skill_defect to a real edit proposal.
async function makeUserSkillOnDisk(config: RuntimeConfig, name: string, body = USER_SKILL_BODY): Promise<string> {
  readState(config.instance);
  writeUserSkill(config.instance, name, body.replace("name: payer", `name: ${name}`));
  await reloadSkills(config);
  const skill = readState(config.instance).skills.find((s) => s.name === name)!;
  return skill.id;
}

function makeBundledSkill(instance: string, name: string): Promise<string> {
  return mutateState(instance, (state) => {
    const skill = createSkill(state, {
      name,
      description: "",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: "enabled",
      body: "# Bundled\n1. Do the thing.",
      source: "bundled"
    });
    return skill.id;
  });
}

describe("reflect.classify probe — routing branches", () => {
  test("skill_defect + user skill + applicable edits -> proposal, no finding, batch reviewed+classified", async () => {
    const instance = "classify-user-proposal";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "payer");
    await seedFailures(instance, skillId, 2);

    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "3. Confirm the payee." }],
      rationale: "Missing a confirm step."
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(1);
    expect(result.findingsCreated).toBe(0);
    expect(result.outcomesReviewed).toBe(2);

    const state = readState(instance);
    expect(state.improvements.filter((p) => p.payload.mode === "edit")).toHaveLength(1);
    expect(state.learningFindings).toHaveLength(0);
    // The proposal path must ALSO persist the verdict classification (the recent
    // fix) — not just findings/dropped batches.
    const reviewed = state.skillOutcomes.filter((o) => o.reviewed);
    expect(reviewed).toHaveLength(2);
    expect(reviewed.every((o) => o.defectClass === "skill_defect")).toBe(true);
    expect(reviewed.every((o) => o.attributable === true)).toBe(true);
  });

  test("skill_defect + bundled skill -> finding, NO disk edit, batch reviewed+classified", async () => {
    const instance = "classify-bundled-finding";
    const config = makeConfig(instance);
    const skillId = await makeBundledSkill(instance, "bundled-payer");
    await seedFailures(instance, skillId, 2);

    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "2. Confirm." }],
      rationale: "Needs confirm."
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(1);

    const state = readState(instance);
    expect(state.improvements.some((p) => p.payload.mode === "edit")).toBe(false);
    expect(state.learningFindings).toHaveLength(1);
    expect(state.learningFindings[0]!.kind).toBe("bundled_skill");
    // skill_defect on a bundled skill is still attributable to the skill — the
    // classification must be persisted onto the consumed outcomes.
    const reviewed = state.skillOutcomes.filter((o) => o.reviewed);
    expect(reviewed.every((o) => o.defectClass === "skill_defect")).toBe(true);
    expect(reviewed.every((o) => o.attributable === true)).toBe(true);
  });

  test("environment verdict -> finding, classification persisted (defectClass=environment, attributable=false)", async () => {
    const instance = "classify-environment";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "fetcher");
    await seedFailures(instance, skillId, 2);

    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "environment",
      attributable: false,
      edits: [],
      rationale: "Upstream API was 503ing.",
      nonSkillFinding: "The vendor API had an outage."
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(1);

    const state = readState(instance);
    expect(state.learningFindings[0]!.kind).toBe("environment");
    const reviewed = state.skillOutcomes.filter((o) => o.reviewed);
    expect(reviewed).toHaveLength(2);
    expect(reviewed.every((o) => o.defectClass === "environment")).toBe(true);
    expect(reviewed.every((o) => o.attributable === false)).toBe(true);
  });

  test("model_ignored verdict -> finding, classification persisted", async () => {
    const instance = "classify-model-ignored";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "trigger-skill");
    await seedFailures(instance, skillId, 2);

    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "model_ignored",
      attributable: false,
      edits: [],
      rationale: "Agent never loaded the skill.",
      nonSkillFinding: "Trigger wording is too vague — the agent didn't reach for it."
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(1);
    const state = readState(instance);
    expect(state.learningFindings[0]!.kind).toBe("model_ignored");
    const reviewed = state.skillOutcomes.filter((o) => o.reviewed);
    expect(reviewed.every((o) => o.defectClass === "model_ignored")).toBe(true);
    expect(reviewed.every((o) => o.attributable === false)).toBe(true);
  });

  test("transient verdict -> DROPPED (no proposal, no finding) but batch reviewed+classified", async () => {
    const instance = "classify-transient-drop";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "flaky");
    await seedFailures(instance, skillId, 2);

    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "transient",
      attributable: false,
      edits: [],
      rationale: "Insufficient signal."
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(0);
    // Dropped, but still reviewed so the next pass doesn't re-reflect it.
    expect(result.outcomesReviewed).toBe(2);

    const state = readState(instance);
    expect(state.learningFindings).toHaveLength(0);
    expect(state.improvements).toHaveLength(0);
    const reviewed = state.skillOutcomes.filter((o) => o.reviewed);
    expect(reviewed).toHaveLength(2);
    // Even a dropped batch must persist the classification (so a score can see
    // the row was already judged transient, not skip-and-forget).
    expect(reviewed.every((o) => o.defectClass === "transient")).toBe(true);
    expect(reviewed.every((o) => o.attributable === false)).toBe(true);
  });

  test("unknown verdict -> DROPPED but reviewed+classified", async () => {
    const instance = "classify-unknown-drop";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "mystery");
    await seedFailures(instance, skillId, 2);

    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "unknown",
      attributable: false,
      edits: [],
      rationale: ""
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(0);
    expect(result.outcomesReviewed).toBe(2);
    const state = readState(instance);
    const reviewed = state.skillOutcomes.filter((o) => o.reviewed);
    expect(reviewed).toHaveLength(2);
    expect(reviewed.every((o) => o.defectClass === "unknown")).toBe(true);
  });
});

describe("reflect.classify probe — floor, clip, deletion, LLM error", () => {
  test(">=2 floor: a single failure is NOT optimized and STAYS unreviewed", async () => {
    const instance = "classify-floor";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "lonely");
    await seedFailures(instance, skillId, 1);

    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "2. More." }],
      rationale: "x"
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(0);
    expect(result.outcomesReviewed).toBe(0);
    // The single below-floor outcome is untouched — no review, no classification.
    const state = readState(instance);
    expect(state.skillOutcomes.every((o) => !o.reviewed)).toBe(true);
    expect(state.skillOutcomes.every((o) => o.defectClass === undefined)).toBe(true);
    expect(state.skillOutcomes.every((o) => o.attributable === undefined)).toBe(true);
  });

  test("floor is exactly 2, not >2: a batch of exactly 2 IS optimized", async () => {
    const instance = "classify-floor-boundary";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "twofail");
    await seedFailures(instance, skillId, 2);

    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "3. Confirm." }],
      rationale: "x"
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(1);
  });

  test("maxProposals clip leaves the clipped batch UNREVIEWED and creates NO finding", async () => {
    const instance = "classify-clip";
    const config = makeConfig(instance);
    for (const name of ["alpha-skill", "beta-skill", "gamma-skill"]) {
      const skillId = await makeUserSkillOnDisk(config, name);
      await seedFailures(instance, skillId, 2);
      setEchoStructuredResponse(`skill-reflect:${skillId}`, {
        defectClass: "skill_defect",
        attributable: true,
        edits: [{ op: "append", content: "3. Confirm." }],
        rationale: "x"
      });
    }

    const result = await reflectOnSkillOutcomes(config, { maxProposals: 1 });
    expect(result.proposalsCreated).toBe(1);
    expect(result.findingsCreated).toBe(0);

    const state = readState(instance);
    expect(state.learningFindings).toHaveLength(0);
    expect(state.improvements.filter((p) => p.payload.mode === "edit")).toHaveLength(1);
    // 6 outcomes total: 2 reviewed (the proposed skill), 4 left unreviewed for a
    // later pass (the two clipped skills).
    expect(state.skillOutcomes.filter((o) => o.reviewed)).toHaveLength(2);
    expect(state.skillOutcomes.filter((o) => !o.reviewed)).toHaveLength(4);
    // The clipped batches must NOT have a stamped classification, since they were
    // never marked reviewed — a stamp without a review would corrupt the score.
    expect(state.skillOutcomes.filter((o) => !o.reviewed).every((o) => o.defectClass === undefined)).toBe(true);
  });

  test("maxProposals=0 clips ALL user-skill defects, leaving every batch unreviewed with no findings", async () => {
    const instance = "classify-clip-zero";
    const config = makeConfig(instance);
    for (const name of ["one-skill", "two-skill"]) {
      const skillId = await makeUserSkillOnDisk(config, name);
      await seedFailures(instance, skillId, 2);
      setEchoStructuredResponse(`skill-reflect:${skillId}`, {
        defectClass: "skill_defect",
        attributable: true,
        edits: [{ op: "append", content: "3. Confirm." }],
        rationale: "x"
      });
    }

    const result = await reflectOnSkillOutcomes(config, { maxProposals: 0 });
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(0);
    const state = readState(instance);
    expect(state.skillOutcomes.every((o) => !o.reviewed)).toBe(true);
    expect(state.learningFindings).toHaveLength(0);
  });

  test("a non-edit verdict is NEVER clipped by maxProposals — a finding still lands even past the budget", async () => {
    const instance = "classify-clip-finding-bypass";
    const config = makeConfig(instance);
    // Skill A: a user-skill defect that consumes the entire proposal budget.
    const aId = await makeUserSkillOnDisk(config, "budget-eater");
    await seedFailures(instance, aId, 2);
    setEchoStructuredResponse(`skill-reflect:${aId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "3. Confirm." }],
      rationale: "x"
    });
    // Skill B: a credential finding — must NOT be suppressed by the clip, since
    // the clip guard only fires for actionable user edits.
    const bId = await makeUserSkillOnDisk(config, "cred-skill");
    await seedFailures(instance, bId, 2);
    setEchoStructuredResponse(`skill-reflect:${bId}`, {
      defectClass: "credential",
      attributable: false,
      edits: [],
      rationale: "Token expired.",
      nonSkillFinding: "Reconnect the integration."
    });

    const result = await reflectOnSkillOutcomes(config, { maxProposals: 1 });
    expect(result.proposalsCreated).toBe(1);
    // The credential finding must still be created — the budget only gates edits.
    expect(result.findingsCreated).toBe(1);
    const state = readState(instance);
    expect(state.learningFindings.some((f) => f.kind === "credential")).toBe(true);
  });

  test("a skill deleted between capture and reflect: batch marked reviewed with NO classification, no proposal/finding", async () => {
    const instance = "classify-deleted-skill";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "ghost");
    await seedFailures(instance, skillId, 2);
    // Delete the skill from state AFTER the outcomes were captured.
    await mutateState(instance, (state) => {
      state.skills = state.skills.filter((s) => s.id !== skillId);
    });
    // Even with a stub registered, no LLM call should happen for a missing skill.
    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "3. Confirm." }],
      rationale: "x"
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(0);
    // The orphaned batch is marked reviewed so it doesn't linger forever.
    expect(result.outcomesReviewed).toBe(2);
    const state = readState(instance);
    expect(state.skillOutcomes.filter((o) => o.reviewed)).toHaveLength(2);
    // No verdict was computed, so no classification is stamped.
    expect(state.skillOutcomes.every((o) => o.defectClass === undefined)).toBe(true);
    expect(state.skillOutcomes.every((o) => o.attributable === undefined)).toBe(true);
    expect(state.learningFindings).toHaveLength(0);
    expect(state.improvements).toHaveLength(0);
  });

  test("an LLM/generateStructured error leaves the batch UNREVIEWED for the next pass", async () => {
    const instance = "classify-llm-error";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "boom");
    await seedFailures(instance, skillId, 2);
    // Register a stub that the validator parses fine, but force the structured
    // call itself to throw by pointing the provider at a non-echo provider with
    // no transport. Simpler+hermetic: monkeypatch is unavailable, so instead we
    // drive an error through a stub whose shape the echo path accepts but the
    // reflect try/catch must swallow. The echo path never throws, so to truly
    // exercise the catch we register a getter that throws when serialized.
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, "defectClass", {
      enumerable: true,
      get() {
        throw new Error("synthetic structured failure");
      }
    });
    setEchoStructuredResponse(`skill-reflect:${skillId}`, throwing);

    const result = await reflectOnSkillOutcomes(config);
    // The catch swallows the error and leaves the batch for the next pass.
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(0);
    expect(result.outcomesReviewed).toBe(0);
    const state = readState(instance);
    expect(state.skillOutcomes.every((o) => !o.reviewed)).toBe(true);
    expect(state.skillOutcomes.every((o) => o.defectClass === undefined)).toBe(true);
  });
});

describe("reflect.classify probe — non-applying edits and selective routing", () => {
  test("skill_defect with edits whose anchors do NOT match (applied===0) does NOT create a proposal — falls to a finding", async () => {
    const instance = "classify-noapply";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "stale-edit");
    await seedFailures(instance, skillId, 2);

    // Every op targets a substring absent from the body, so applySkillEdits
    // applies 0 ops. The body has no "Nonexistent anchor here" text.
    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [
        { op: "insert_after", anchor: "Nonexistent anchor here", content: "X" },
        { op: "replace", target: "Also missing target", content: "Y" },
        { op: "delete", target: "Missing delete target" }
      ],
      rationale: "Edits reference a stale body."
    });

    const result = await reflectOnSkillOutcomes(config);
    // No proposal — the candidate applied 0 ops. It is NOT silently dropped: a
    // skill_defect with no actionable edit becomes a finding pointing at the
    // source so the recurring defect is still surfaced.
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(1);
    const state = readState(instance);
    expect(state.improvements.some((p) => p.payload.mode === "edit")).toBe(false);
    expect(state.learningFindings).toHaveLength(1);
    expect(state.learningFindings[0]!.kind).toBe("bundled_skill");
    // The batch is reviewed and classified.
    const reviewed = state.skillOutcomes.filter((o) => o.reviewed);
    expect(reviewed).toHaveLength(2);
    expect(reviewed.every((o) => o.defectClass === "skill_defect")).toBe(true);
  });

  test("skill_defect with EMPTY edits on a user skill -> finding (not a proposal)", async () => {
    const instance = "classify-empty-edits";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "no-edits");
    await seedFailures(instance, skillId, 2);

    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [],
      rationale: "Defect identified but no concrete edit proposed."
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(0);
    expect(result.findingsCreated).toBe(1);
    expect(readState(instance).improvements.some((p) => p.payload.mode === "edit")).toBe(false);
  });

  test("a partially-applying edit batch (one op matches) DOES create a proposal", async () => {
    const instance = "classify-partial-apply";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "partial");
    await seedFailures(instance, skillId, 2);

    // "Click Pay." exists in USER_SKILL_BODY; the other two ops miss. applied=2
    // (append always applies + the matching replace) > 0 -> proposal.
    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [
        { op: "replace", target: "Click Pay.", content: "Confirm payee, then Click Pay." },
        { op: "delete", target: "Totally absent text" }
      ],
      rationale: "Add a confirmation."
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(1);
    const proposal = readState(instance).improvements.find((p) => p.payload.mode === "edit")!;
    expect(String(proposal.payload.candidateBody)).toContain("Confirm payee, then Click Pay.");
  });

  test("the agentId filter scopes the reflection to one agent's failures only", async () => {
    const instance = "classify-agent-filter";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "shared-skill");
    // Agent A has 2 failures, agent B has 2 failures on the SAME skill.
    await seedFailures(instance, skillId, 2, { taskPrefix: "a", agentId: "agentA" });
    await seedFailures(instance, skillId, 2, { taskPrefix: "b", agentId: "agentB" });
    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "3. Confirm." }],
      rationale: "x"
    });

    const result = await reflectOnSkillOutcomes(config, { agentId: "agentA" });
    expect(result.proposalsCreated).toBe(1);
    // Only agent A's 2 outcomes are reviewed; agent B's stay untouched.
    expect(result.outcomesReviewed).toBe(2);
    const state = readState(instance);
    const reviewedAgents = new Set(state.skillOutcomes.filter((o) => o.reviewed).map((o) => o.agentId));
    expect([...reviewedAgents]).toEqual(["agentA"]);
    expect(state.skillOutcomes.filter((o) => o.agentId === "agentB" && o.reviewed)).toHaveLength(0);
  });

  test("a sub-floor batch on one skill does not block a qualifying batch on another", async () => {
    const instance = "classify-mixed-floor";
    const config = makeConfig(instance);
    const goodId = await makeUserSkillOnDisk(config, "good-skill");
    const lonelyId = await makeUserSkillOnDisk(config, "lonely-skill");
    await seedFailures(instance, goodId, 2);
    await seedFailures(instance, lonelyId, 1);
    setEchoStructuredResponse(`skill-reflect:${goodId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "3. Confirm." }],
      rationale: "x"
    });
    setEchoStructuredResponse(`skill-reflect:${lonelyId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "3. Confirm." }],
      rationale: "x"
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(1);
    expect(result.outcomesReviewed).toBe(2);
    const state = readState(instance);
    // The lonely skill's single failure stays unreviewed.
    expect(state.skillOutcomes.filter((o) => o.skillId === lonelyId).every((o) => !o.reviewed)).toBe(true);
  });

  test("sourceTraceIds carry real trace ids when the source task has trace, never the taskIds", async () => {
    const instance = "classify-traceids";
    const config = makeConfig(instance);
    const skillId = await makeUserSkillOnDisk(config, "traced");
    const taskIds = await seedFailures(instance, skillId, 2);
    // Reflect derives its trace lookup from sourceTaskIds[0], which is the FIRST
    // entry of the failure batch — and createSkillOutcome inserts newest-first,
    // so that is the LAST seeded task. Append trace to every seeded task so the
    // assertion is independent of that internal batch ordering.
    for (const taskId of taskIds) {
      for (let i = 0; i < 7; i++) {
        appendTrace(instance, taskId, { type: "tool", message: `step ${i}` });
      }
    }
    setEchoStructuredResponse(`skill-reflect:${skillId}`, {
      defectClass: "skill_defect",
      attributable: true,
      edits: [{ op: "append", content: "3. Confirm." }],
      rationale: "x"
    });

    const result = await reflectOnSkillOutcomes(config);
    expect(result.proposalsCreated).toBe(1);
    const proposal = readState(instance).improvements.find((p) => p.payload.mode === "edit")!;
    // Last 5 trace ids, none equal to a taskId.
    expect(proposal.sourceTraceIds).toHaveLength(5);
    expect(proposal.sourceTraceIds.some((tid) => taskIds.includes(tid))).toBe(false);
    expect(proposal.sourceTraceIds.every((tid) => tid.startsWith("trace_"))).toBe(true);
  });
});
