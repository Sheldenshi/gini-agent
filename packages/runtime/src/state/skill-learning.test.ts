// Skill-learning state: SkillOutcome / LearningFinding CRUD + normalizeState
// defaults, plus the applyImprovement edit branch (user-skill body rewritten
// via installSkillFromBody; bundled target rejected; baseBody stored).
// ADR skill-learning-from-outcomes.md.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEmptyState, mutateState, normalizeState, readState, writeState } from "./store";
import { createSkillOutcome, createLearningFinding } from "./records";
import { reviewImprovement, proposeImprovement } from "../governance/improvements";
import { reloadSkills } from "../capabilities/skills";
import type { RuntimeConfig, RuntimeState } from "../types";

const ROOT = "/tmp/gini-skill-learning-state-test";

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

describe("skill-learning normalizeState defaults", () => {
  test("createEmptyState seeds empty rings", () => {
    const state = createEmptyState("inst");
    expect(state.skillOutcomes).toEqual([]);
    expect(state.learningFindings).toEqual([]);
  });

  test("normalizeState backfills missing arrays on legacy state", () => {
    const legacy = createEmptyState("inst") as unknown as Record<string, unknown>;
    delete legacy.skillOutcomes;
    delete legacy.learningFindings;
    const normalized = normalizeState("inst", legacy as unknown as RuntimeState);
    expect(normalized.skillOutcomes).toEqual([]);
    expect(normalized.learningFindings).toEqual([]);
  });
});

describe("skill-learning CRUD", () => {
  test("createSkillOutcome inserts newest-first and is bounded", () => {
    const state = createEmptyState("inst");
    const a = createSkillOutcome(state, {
      taskId: "task_a",
      signal: "failure",
      source: "objective",
      consequential: true,
      selfVerifiable: true,
      reviewed: false,
      feedbackPrompted: false
    });
    const b = createSkillOutcome(state, {
      taskId: "task_b",
      signal: "success",
      source: "objective",
      consequential: false,
      selfVerifiable: true,
      reviewed: false,
      feedbackPrompted: false
    });
    expect(state.skillOutcomes[0]!.id).toBe(b.id);
    expect(state.skillOutcomes[1]!.id).toBe(a.id);
    expect(a.id.startsWith("skillout_")).toBe(true);
  });

  test("retention is per-skill — a chatty skill can't evict a quiet skill's rows", () => {
    const state = createEmptyState("inst");
    // A quiet skill logs one outcome first.
    const quiet = createSkillOutcome(state, {
      taskId: "task_quiet",
      skillId: "skill_quiet",
      signal: "success",
      source: "objective",
      consequential: false,
      selfVerifiable: true,
      reviewed: false,
      feedbackPrompted: false
    });
    // A chatty skill then logs far more than the per-skill cap (100).
    for (let i = 0; i < 250; i += 1) {
      createSkillOutcome(state, {
        taskId: `task_chatty_${i}`,
        skillId: "skill_chatty",
        signal: "failure",
        source: "objective",
        consequential: false,
        selfVerifiable: true,
        reviewed: false,
        feedbackPrompted: false
      });
    }
    const chattyRows = state.skillOutcomes.filter((o) => o.skillId === "skill_chatty");
    const quietRows = state.skillOutcomes.filter((o) => o.skillId === "skill_quiet");
    // The chatty skill is capped at its per-skill limit...
    expect(chattyRows.length).toBe(100);
    // ...and the quiet skill's single row survives — a global ring would have
    // evicted it long ago.
    expect(quietRows).toHaveLength(1);
    expect(quietRows[0]!.id).toBe(quiet.id);
  });

  test("createLearningFinding defaults status open", () => {
    const state = createEmptyState("inst");
    const finding = createLearningFinding(state, {
      kind: "credential",
      summary: "Gmail token keeps expiring",
      sourceTaskIds: ["task_a", "task_b"]
    });
    expect(finding.status).toBe("open");
    expect(state.learningFindings[0]!.id).toBe(finding.id);
  });
});

// Install a user skill on disk under the instance skills dir, returning the
// reloaded record. installSkillFromBody is the validated write path, but here
// we want to control the manifest layout precisely, so we write the file and
// reload.
function writeUserSkill(instance: string, name: string, body: string): string {
  const dir = join(ROOT, "instances", instance, "skills", name);
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "SKILL.md");
  writeFileSync(manifestPath, body);
  return manifestPath;
}

const USER_SKILL_BODY = `---
name: payment-flow
description: Pay an invoice
---

# Payment flow

1. Open the invoice.
2. Click Pay.
`;

describe("applyImprovement edit branch", () => {
  test("rewrites a user skill's body via installSkillFromBody and stores baseBody", async () => {
    const instance = "edit-user";
    const config = makeConfig(instance);
    // Seed the instance state file, then drop a user skill on disk + reload.
    readState(instance);
    writeUserSkill(instance, "payment-flow", USER_SKILL_BODY);
    await reloadSkills(config);
    const before = readState(instance).skills.find((s) => s.name === "payment-flow");
    expect(before).toBeDefined();
    expect(before!.source).toBe("user");

    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Confirm before paying",
      rationale: "Two failures paid the wrong invoice.",
      payload: {
        mode: "edit",
        targetSkillId: before!.id,
        baseVersion: before!.version,
        baseBody: before!.body,
        edits: [{ op: "append", content: "3. Confirm the payee before clicking Pay." }]
      }
    });

    const applied = await reviewImprovement(config, proposal.id, "approve");
    expect(applied.status).toBe("applied");
    expect(applied.appliedTargetId).toBe(before!.id);
    // baseBody preserved on the proposal for revert.
    expect(String(applied.payload.baseBody)).toBe(before!.body);

    const after = readState(instance).skills.find((s) => s.name === "payment-flow");
    expect(after!.body).toContain("Confirm the payee before clicking Pay.");
    // The original body is still there — append, not replace.
    expect(after!.body).toContain("Open the invoice.");
  });

  test("rejects a bundled skill target", async () => {
    const instance = "edit-bundled";
    const config = makeConfig(instance);
    // Mark a skill row as bundled with no manifestPath — the edit branch must
    // refuse it (findings only for bundled/legacy skills).
    await mutateState(instance, (state) => {
      state.skills.unshift({
        id: "skill_bundled",
        instance,
        name: "bundled-skill",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled",
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tests: [],
        successCount: 0,
        failureCount: 0,
        previousVersions: [],
        body: "# Bundled\n",
        source: "bundled"
      });
    });

    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Edit bundled",
      rationale: "should be refused",
      payload: {
        mode: "edit",
        targetSkillId: "skill_bundled",
        baseBody: "# Bundled\n",
        edits: [{ op: "append", content: "x" }]
      }
    });

    await expect(reviewImprovement(config, proposal.id, "approve")).rejects.toThrow();
    // The proposal must not be left "applied" after a failed apply, and it must
    // be releasable back to "proposed" so a retry can re-approve.
    const stored = readState(instance).improvements.find((p) => p.id === proposal.id);
    expect(stored!.status).not.toBe("applied");
    expect(stored!.status).toBe("proposed");
  });

  test("concurrent double-approve applies the edit once and audits once", async () => {
    const instance = "edit-race";
    const config = makeConfig(instance);
    readState(instance);
    writeUserSkill(instance, "payment-flow", USER_SKILL_BODY);
    await reloadSkills(config);
    const before = readState(instance).skills.find((s) => s.name === "payment-flow")!;

    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Confirm before paying",
      rationale: "Two failures paid the wrong invoice.",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        edits: [{ op: "append", content: "3. Confirm the payee before clicking Pay." }]
      }
    });

    // Fire two approves concurrently. Exactly one wins (status -> applied); the
    // other sees the claim and rejects with "already ...". The append must NOT
    // be doubled, and improvement.applied must be audited exactly once.
    const results = await Promise.allSettled([
      reviewImprovement(config, proposal.id, "approve"),
      reviewImprovement(config, proposal.id, "approve")
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const state = readState(instance);
    const stored = state.improvements.find((p) => p.id === proposal.id)!;
    expect(stored.status).toBe("applied");

    const after = state.skills.find((s) => s.name === "payment-flow")!;
    // The append landed exactly once (no double-append).
    const occurrences = after.body.split("3. Confirm the payee before clicking Pay.").length - 1;
    expect(occurrences).toBe(1);

    const appliedAudits = state.audit.filter(
      (a) => a.action === "improvement.applied" && a.target === proposal.id
    );
    expect(appliedAudits).toHaveLength(1);
  });

  test("a fully-stale edit (no op matches the live body) is refused, not silently applied", async () => {
    const instance = "edit-stale";
    const config = makeConfig(instance);
    readState(instance);
    writeUserSkill(instance, "payment-flow", USER_SKILL_BODY);
    await reloadSkills(config);
    const before = readState(instance).skills.find((s) => s.name === "payment-flow")!;

    const proposal = await proposeImprovement(config, {
      kind: "skill",
      title: "Replace a step that no longer exists",
      rationale: "Body changed since the proposal was generated.",
      payload: {
        mode: "edit",
        targetSkillId: before.id,
        baseVersion: before.version,
        baseBody: before.body,
        // This target is not a substring of the live body -> applied === 0.
        edits: [{ op: "replace", target: "Step that does not exist in the body", content: "x" }]
      }
    });

    await expect(reviewImprovement(config, proposal.id, "approve")).rejects.toThrow(
      /changed since this proposal/
    );
    const state = readState(instance);
    const stored = state.improvements.find((p) => p.id === proposal.id)!;
    // Not applied, and released back to proposed for re-review.
    expect(stored.status).toBe("proposed");
    // The on-disk body is untouched (no no-op write flipped it to applied).
    const after = state.skills.find((s) => s.name === "payment-flow")!;
    expect(after.body).toBe(before.body);
  });
});
