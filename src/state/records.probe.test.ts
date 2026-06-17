// Adversarial retention probes for skill-learning rows
// (ADR skill-learning-from-outcomes.md):
//   - createSkillOutcome per-skill cap (no cross-skill eviction; newest kept)
//   - the unattributed (no skillId) bucket has its own cap
//   - the global backstop still bounds total rows
//   - createLearningFinding default status + bound
//   - normalizeState defaults for legacy state files missing the new fields
//
// Hermetic: unique GINI_STATE_ROOT containing the slice name so parallel
// probers can't collide. Most assertions operate on an in-memory state from
// createEmptyState (no disk I/O), so they don't depend on the env root, but we
// still scope it to be safe for the readState-backed cases.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createEmptyState, normalizeState } from "./store";
import { createSkillOutcome, createLearningFinding } from "./records";
import type { RuntimeState, SkillOutcome } from "../types";

const ROOT = "/tmp/gini-records-probe-retention-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// Minimal valid outcome input; callers override skillId/taskId/signal.
function outcomeInput(
  overrides: Partial<Omit<SkillOutcome, "id" | "instance" | "createdAt">> = {}
): Omit<SkillOutcome, "id" | "instance" | "createdAt"> {
  return {
    taskId: "task_x",
    signal: "failure",
    source: "objective",
    consequential: false,
    selfVerifiable: true,
    reviewed: false,
    feedbackPrompted: false,
    ...overrides
  };
}

const PER_SKILL_CAP = 100;
const GLOBAL_CAP = 5000;
const FINDINGS_CAP = 500;

describe("createSkillOutcome per-skill retention", () => {
  test("a quiet skill survives a chatty skill flooding far past the per-skill cap", () => {
    const state = createEmptyState("inst");
    const quiet = createSkillOutcome(state, outcomeInput({ skillId: "skill_quiet", taskId: "q0", signal: "success" }));
    // Flood one chatty skill with 5x the per-skill cap. A global ring keyed on
    // total length would evict the lone quiet row long before this finishes.
    for (let i = 0; i < PER_SKILL_CAP * 5; i += 1) {
      createSkillOutcome(state, outcomeInput({ skillId: "skill_chatty", taskId: `c${i}` }));
    }
    const quietRows = state.skillOutcomes.filter((o) => o.skillId === "skill_quiet");
    const chattyRows = state.skillOutcomes.filter((o) => o.skillId === "skill_chatty");
    expect(quietRows).toHaveLength(1);
    expect(quietRows[0]!.id).toBe(quiet.id);
    expect(chattyRows).toHaveLength(PER_SKILL_CAP);
  });

  test("interleaved high+low volume skills: every quiet row survives, each chatty skill capped independently", () => {
    const state = createEmptyState("inst");
    // Three quiet skills, each one row, interleaved with chatty floods so a
    // naive global trim would clip the earliest quiet rows.
    const quietIds: Record<string, string> = {};
    for (const q of ["alpha", "beta", "gamma"]) {
      quietIds[q] = createSkillOutcome(state, outcomeInput({ skillId: `quiet_${q}`, taskId: `q_${q}` })).id;
      for (let i = 0; i < 150; i += 1) {
        createSkillOutcome(state, outcomeInput({ skillId: `chatty_${q}`, taskId: `c_${q}_${i}` }));
      }
    }
    for (const q of ["alpha", "beta", "gamma"]) {
      const survivors = state.skillOutcomes.filter((o) => o.skillId === `quiet_${q}`);
      expect(survivors).toHaveLength(1);
      expect(survivors[0]!.id).toBe(quietIds[q]);
      expect(state.skillOutcomes.filter((o) => o.skillId === `chatty_${q}`)).toHaveLength(PER_SKILL_CAP);
    }
  });

  test("at the cap boundary the OLDEST row of that skill is the one evicted (newest kept)", () => {
    const state = createEmptyState("inst");
    // Insert exactly cap+1 rows for one skill; tag them so we can identify
    // which survived by their taskId ordinal.
    const ids: string[] = [];
    for (let i = 0; i < PER_SKILL_CAP + 1; i += 1) {
      ids.push(createSkillOutcome(state, outcomeInput({ skillId: "skill_seq", taskId: `seq_${i}` })).id);
    }
    const rows = state.skillOutcomes.filter((o) => o.skillId === "skill_seq");
    expect(rows).toHaveLength(PER_SKILL_CAP);
    // The very first inserted row (oldest, ordinal 0) must be gone.
    expect(rows.some((o) => o.id === ids[0])).toBe(false);
    expect(rows.some((o) => o.taskId === "seq_0")).toBe(false);
    // The most recent insert (ordinal cap) must survive and be at the head
    // (newest-first via unshift).
    expect(rows.some((o) => o.id === ids[PER_SKILL_CAP])).toBe(true);
    expect(state.skillOutcomes[0]!.id).toBe(ids[PER_SKILL_CAP]);
    // Surviving rows are exactly ordinals 1..cap, newest-first.
    expect(rows.map((o) => o.taskId)).toEqual(
      Array.from({ length: PER_SKILL_CAP }, (_, k) => `seq_${PER_SKILL_CAP - k}`)
    );
  });

  test("the bucket key is skillId alone — two skills under the SAME agent are capped independently", () => {
    const state = createEmptyState("inst");
    // If the cap were ever keyed on agentId (or anything but skillId), skill_b's
    // flood would evict skill_a's rows even though they're distinct skills.
    for (let i = 0; i < 40; i += 1) {
      createSkillOutcome(state, outcomeInput({ skillId: "skill_a", agentId: "agent_shared", taskId: `a${i}` }));
    }
    for (let i = 0; i < PER_SKILL_CAP * 2; i += 1) {
      createSkillOutcome(state, outcomeInput({ skillId: "skill_b", agentId: "agent_shared", taskId: `b${i}` }));
    }
    expect(state.skillOutcomes.filter((o) => o.skillId === "skill_a")).toHaveLength(40);
    expect(state.skillOutcomes.filter((o) => o.skillId === "skill_b")).toHaveLength(PER_SKILL_CAP);
  });

  test("exactly at the cap (100) nothing is evicted", () => {
    const state = createEmptyState("inst");
    for (let i = 0; i < PER_SKILL_CAP; i += 1) {
      createSkillOutcome(state, outcomeInput({ skillId: "skill_exact", taskId: `e${i}` }));
    }
    expect(state.skillOutcomes.filter((o) => o.skillId === "skill_exact")).toHaveLength(PER_SKILL_CAP);
    // All ordinals 0..99 present.
    const tasks = new Set(state.skillOutcomes.map((o) => o.taskId));
    for (let i = 0; i < PER_SKILL_CAP; i += 1) expect(tasks.has(`e${i}`)).toBe(true);
  });
});

describe("unattributed (no skillId) bucket retention", () => {
  test("the no-skillId bucket has its own per-skill cap, independent of attributed skills", () => {
    const state = createEmptyState("inst");
    // One attributed skill with a single row.
    const attributed = createSkillOutcome(state, outcomeInput({ skillId: "skill_real", taskId: "real0" })).id;
    // Flood the unattributed bucket past the cap.
    for (let i = 0; i < PER_SKILL_CAP * 2; i += 1) {
      createSkillOutcome(state, outcomeInput({ taskId: `unattr_${i}` })); // no skillId
    }
    const unattr = state.skillOutcomes.filter((o) => o.skillId === undefined);
    const attr = state.skillOutcomes.filter((o) => o.skillId === "skill_real");
    // Unattributed bucket capped on its own.
    expect(unattr).toHaveLength(PER_SKILL_CAP);
    // The attributed skill is NOT evicted by unattributed pressure.
    expect(attr).toHaveLength(1);
    expect(attr[0]!.id).toBe(attributed);
  });

  test("undefined skillId and empty-string skillId fall into the SAME unattributed bucket", () => {
    const state = createEmptyState("inst");
    // Mix undefined and "" skillIds; both map to key "" so together they share
    // one cap. Insert cap rows with undefined, then cap rows with "".
    for (let i = 0; i < PER_SKILL_CAP; i += 1) {
      createSkillOutcome(state, outcomeInput({ taskId: `u${i}` })); // undefined
    }
    for (let i = 0; i < PER_SKILL_CAP; i += 1) {
      createSkillOutcome(state, outcomeInput({ skillId: "", taskId: `b${i}` })); // empty string
    }
    // Combined they share the "" bucket -> total kept is the single per-skill
    // cap, NOT 2x. The newest cap rows (the empty-string ones) win.
    const bucket = state.skillOutcomes.filter((o) => (o.skillId ?? "") === "");
    expect(bucket).toHaveLength(PER_SKILL_CAP);
    // All survivors are from the later empty-string batch; the earlier
    // undefined batch was fully evicted because it was older in the same bucket.
    expect(bucket.every((o) => o.taskId.startsWith("b"))).toBe(true);
  });
});

describe("global backstop", () => {
  test("createSkillOutcome trims total rows to the global cap when an oversized state is loaded", () => {
    const state = createEmptyState("inst");
    // Pre-seed an already-oversized ring with many distinct skills so no single
    // per-skill bucket is over cap (each skill has 1 row), only the GLOBAL total
    // exceeds the backstop. This isolates the global trim from the per-skill one.
    const seeded: SkillOutcome[] = [];
    for (let i = 0; i < GLOBAL_CAP + 50; i += 1) {
      seeded.push({
        id: `skillout_seed_${i}`,
        instance: "inst",
        skillId: `skill_${i}`, // unique skill per row -> no per-skill eviction
        taskId: `t_${i}`,
        signal: "failure",
        source: "objective",
        consequential: false,
        selfVerifiable: true,
        reviewed: false,
        feedbackPrompted: false,
        createdAt: new Date().toISOString()
      });
    }
    state.skillOutcomes = seeded;
    // Insert one more row under a fresh unique skill; the global backstop must
    // clamp the total to GLOBAL_CAP.
    createSkillOutcome(state, outcomeInput({ skillId: "skill_fresh", taskId: "fresh" }));
    expect(state.skillOutcomes.length).toBe(GLOBAL_CAP);
    // The just-inserted row is newest-first and survives the slice(0, cap).
    expect(state.skillOutcomes[0]!.taskId).toBe("fresh");
    // The global trim keeps the head (newest) and drops the tail (oldest seeds).
    expect(state.skillOutcomes.some((o) => o.taskId === `t_${GLOBAL_CAP + 49}`)).toBe(false);
  });
});

describe("createLearningFinding", () => {
  test("defaults status to open and inserts newest-first", () => {
    const state = createEmptyState("inst");
    const a = createLearningFinding(state, { kind: "environment", summary: "DNS flaky", sourceTaskIds: ["t1"] });
    const b = createLearningFinding(state, { kind: "credential", summary: "token expired", sourceTaskIds: ["t2"] });
    expect(a.status).toBe("open");
    expect(b.status).toBe("open");
    expect(state.learningFindings[0]!.id).toBe(b.id);
    expect(state.learningFindings[1]!.id).toBe(a.id);
  });

  test("is bounded at the findings cap, keeping the newest", () => {
    const state = createEmptyState("inst");
    let lastId = "";
    for (let i = 0; i < FINDINGS_CAP + 25; i += 1) {
      lastId = createLearningFinding(state, {
        kind: "model_ignored",
        summary: `finding ${i}`,
        sourceTaskIds: [`t${i}`]
      }).id;
    }
    expect(state.learningFindings).toHaveLength(FINDINGS_CAP);
    // Newest survives at the head; the very first finding is evicted.
    expect(state.learningFindings[0]!.id).toBe(lastId);
    expect(state.learningFindings.some((f) => f.summary === "finding 0")).toBe(false);
    expect(state.learningFindings.some((f) => f.summary === `finding ${FINDINGS_CAP + 24}`)).toBe(true);
  });

  test("optional agentId/skillId/skillName pass through and createdAt is stamped", () => {
    const state = createEmptyState("inst");
    const finding = createLearningFinding(state, {
      kind: "bundled_skill",
      summary: "stale bundled skill",
      sourceTaskIds: ["t"],
      agentId: "agent_1",
      skillId: "skill_1",
      skillName: "my-skill"
    });
    expect(finding.status).toBe("open");
    expect(finding.agentId).toBe("agent_1");
    expect(finding.skillId).toBe("skill_1");
    expect(finding.skillName).toBe("my-skill");
    expect(typeof finding.createdAt).toBe("string");
    expect(finding.id.startsWith("finding_")).toBe(true);
  });
});

describe("normalizeState defaults for legacy state files", () => {
  test("backfills missing skillOutcomes / learningFindings to []", () => {
    const legacy = createEmptyState("inst") as unknown as Record<string, unknown>;
    delete legacy.skillOutcomes;
    delete legacy.learningFindings;
    const normalized = normalizeState("inst", legacy as unknown as RuntimeState);
    expect(normalized.skillOutcomes).toEqual([]);
    expect(normalized.learningFindings).toEqual([]);
  });

  test("does NOT clobber existing skillOutcomes / learningFindings rows", () => {
    const state = createEmptyState("inst");
    const outcome = createSkillOutcome(state, outcomeInput({ skillId: "skill_keep", taskId: "keep" }));
    const finding = createLearningFinding(state, { kind: "environment", summary: "keep", sourceTaskIds: ["k"] });
    const normalized = normalizeState("inst", state);
    expect(normalized.skillOutcomes).toHaveLength(1);
    expect(normalized.skillOutcomes[0]!.id).toBe(outcome.id);
    expect(normalized.learningFindings).toHaveLength(1);
    expect(normalized.learningFindings[0]!.id).toBe(finding.id);
  });

  test("lastSkillReviewDigestAt is passthrough: preserved when present, left absent when missing", () => {
    // Present -> preserved verbatim.
    const withDigest = createEmptyState("inst") as RuntimeState;
    withDigest.lastSkillReviewDigestAt = "2026-01-01T00:00:00.000Z";
    const normalizedWith = normalizeState("inst", withDigest);
    expect(normalizedWith.lastSkillReviewDigestAt).toBe("2026-01-01T00:00:00.000Z");

    // Absent -> stays undefined (no spurious default).
    const without = createEmptyState("inst") as unknown as Record<string, unknown>;
    delete without.lastSkillReviewDigestAt;
    const normalizedWithout = normalizeState("inst", without as unknown as RuntimeState);
    expect(normalizedWithout.lastSkillReviewDigestAt).toBeUndefined();
  });

  test("normalizeState tolerates a null skillOutcomes value (hand-edited file) without throwing", () => {
    // ??= only triggers on null/undefined; a JSON file with `"skillOutcomes": null`
    // must normalize to [] rather than crash a later .unshift.
    const legacy = createEmptyState("inst") as unknown as Record<string, unknown>;
    legacy.skillOutcomes = null;
    legacy.learningFindings = null;
    const normalized = normalizeState("inst", legacy as unknown as RuntimeState);
    expect(normalized.skillOutcomes).toEqual([]);
    expect(normalized.learningFindings).toEqual([]);
    // And a subsequent insert works on the repaired array.
    expect(() => createSkillOutcome(normalized, outcomeInput({ skillId: "s", taskId: "t" }))).not.toThrow();
    expect(normalized.skillOutcomes).toHaveLength(1);
  });
});

describe("createEmptyState seeds", () => {
  test("seeds empty skill-learning rings and no digest timestamp", () => {
    const state = createEmptyState("inst");
    expect(state.skillOutcomes).toEqual([]);
    expect(state.learningFindings).toEqual([]);
    expect(state.lastSkillReviewDigestAt).toBeUndefined();
  });
});
