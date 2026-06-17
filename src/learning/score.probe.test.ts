// Adversarial probe of the read-only skill reliability score (score.ts).
//
// This file tries to make scoreSkill / computeSkillScores LIE: surface a false
// "reliable"/healthy reading, let unverified work raise the rate, let excluded
// environmental failures drag it, or let exclusion be granted for free. Each
// test pins one honesty rule and asserts the precise math, so a regression that
// over-claims (false green) fails here.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createSkill, mutateState, readState } from "../state";
import { scoreSkill, computeSkillScores } from "./score";
import type { DefectClass, OutcomeSource, RuntimeConfig, SkillOutcome } from "../types";

// Unique per-file state root so parallel probers don't collide.
const ROOT = "/tmp/gini-score-probe-test";

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

const NOW = Date.parse("2026-06-16T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

// Prior + weight constants, mirrored so tests assert exact expected scores.
const PRIOR_A0 = 2.8;
const PRIOR_B0 = 1.2;
const UF_W = 1.5;
const OBJ_W = 1.0;

let seq = 0;
function outcome(partial: Partial<SkillOutcome> & { signal: SkillOutcome["signal"] }): SkillOutcome {
  seq += 1;
  return {
    id: `out_${seq}`,
    instance: "test",
    taskId: `task_${seq}`,
    skillId: "skill_x",
    skillName: "x",
    source: "objective" as OutcomeSource,
    consequential: false,
    selfVerifiable: true,
    reviewed: true,
    feedbackPrompted: false,
    createdAt: new Date(NOW).toISOString(),
    ...partial
  };
}

function objSuccessVerified(extra: Partial<SkillOutcome> = {}): SkillOutcome {
  return outcome({ signal: "success", source: "objective", selfVerifiable: true, ...extra });
}
function ufSuccess(extra: Partial<SkillOutcome> = {}): SkillOutcome {
  return outcome({
    signal: "success",
    source: "user_feedback",
    consequential: true,
    selfVerifiable: false,
    feedbackPrompted: true,
    ...extra
  });
}
function unverifiedConsequentialSuccess(extra: Partial<SkillOutcome> = {}): SkillOutcome {
  return outcome({
    signal: "success",
    source: "objective",
    consequential: true,
    selfVerifiable: false,
    ...extra
  });
}
function failure(defectClass?: DefectClass, extra: Partial<SkillOutcome> = {}): SkillOutcome {
  return outcome({ signal: "failure", selfVerifiable: true, defectClass, ...extra });
}

// Reference implementation of the score for N verified successes + M counted
// failures, all fresh (undecayed). Used to assert exact numbers.
function expectedScore(verifiedSuccessW: number, countedFailW: number): number {
  const sumW = verifiedSuccessW + countedFailW;
  const sumWV = verifiedSuccessW;
  return (100 * (PRIOR_A0 + sumWV)) / (PRIOR_A0 + PRIOR_B0 + sumW);
}

describe("scoreSkill — honesty under adversarial inputs", () => {
  // (a) Unverified consequential successes must NEVER raise verifiedScore, no
  // matter how many you pile on. The most aggressive version of the existing
  // test: drown the verified set in 100 unverified successes and confirm the
  // score is byte-identical to the no-success baseline.
  test("100 unverified consequential successes cannot raise verifiedScore one iota", () => {
    const base = [failure("skill_defect"), failure("skill_defect")];
    const baseScore = scoreSkill("skill_x", "x", base, NOW).verifiedScore!;

    const flooded = [...base];
    for (let i = 0; i < 100; i++) flooded.push(unverifiedConsequentialSuccess());
    const s = scoreSkill("skill_x", "x", flooded, NOW);

    expect(s.verifiedScore!).toBe(baseScore);
    expect(s.verifiedN).toBeCloseTo(2, 9); // the 100 unverified did NOT enter verifiedN
    expect(s.unverifiedConsequentialN).toBeCloseTo(100, 6);
    // Tier must still reflect the two failures (low), not a flood of green.
    expect(s.tier).toBe("unproven");
  });

  // A single verified failure + a flood of unverified successes must stay
  // UNRATED (verifiedN = 1 < 2). The flood cannot manufacture a rating.
  test("unverified successes cannot lift a 1-failure skill out of UNRATED", () => {
    const outcomes = [failure("skill_defect")];
    for (let i = 0; i < 50; i++) outcomes.push(unverifiedConsequentialSuccess());
    const s = scoreSkill("skill_x", "x", outcomes, NOW);
    expect(s.tier).toBe("unrated");
    expect(s.verifiedScore).toBeNull();
    expect(s.verifiedN).toBeCloseTo(1, 9);
    expect(s.unverifiedConsequentialN).toBeCloseTo(50, 6);
  });

  // (b) Each excluded defect class must leave the verified set untouched —
  // a mountain of environment/credential/transient failures must not drag a
  // genuinely-good skill below "reliable".
  test("excluded failures (env/cred/transient) never lower a reliable skill's score", () => {
    const good: SkillOutcome[] = [];
    for (let i = 0; i < 6; i++) good.push(objSuccessVerified());
    const cleanScore = scoreSkill("skill_x", "x", good, NOW).verifiedScore!;
    const cleanTier = scoreSkill("skill_x", "x", good, NOW).tier;
    expect(cleanTier).toBe("reliable");

    const polluted = [...good];
    for (let i = 0; i < 20; i++) polluted.push(failure("environment"));
    for (let i = 0; i < 20; i++) polluted.push(failure("credential"));
    for (let i = 0; i < 20; i++) polluted.push(failure("transient"));
    const s = scoreSkill("skill_x", "x", polluted, NOW);

    // Score and verifiedN identical: the 60 excluded failures are invisible.
    expect(s.verifiedScore!).toBe(cleanScore);
    expect(s.verifiedN).toBe(scoreSkill("skill_x", "x", good, NOW).verifiedN);
    expect(s.tier).toBe("reliable");
  });

  // (c) Unclassified (undefined) failures must count at FULL weight — exclusion
  // is earned by classification, never granted for sitting unreviewed.
  test("undefined defectClass counts at full weight (same as skill_defect)", () => {
    const unclassified = scoreSkill("skill_x", "x", [failure(undefined), failure(undefined)], NOW);
    const defected = scoreSkill(
      "skill_x",
      "x",
      [failure("skill_defect"), failure("skill_defect")],
      NOW
    );
    expect(unclassified.verifiedScore!).toBe(defected.verifiedScore!);
    expect(unclassified.verifiedN).toBeCloseTo(2, 9);
    // Exactly the prior-only-failures number: 100 * 2.8 / (4 + 2) = 46.666...
    expect(unclassified.verifiedScore!).toBeCloseTo(expectedScore(0, 2), 9);
  });

  // (c-2) model_ignored failures must ALSO count (they are NOT in the excluded
  // set). An adversary who labels every failure model_ignored cannot escape.
  test("model_ignored failures count at full weight (not excluded)", () => {
    const s = scoreSkill(
      "skill_x",
      "x",
      [failure("model_ignored"), failure("model_ignored")],
      NOW
    );
    expect(s.tier).not.toBe("unrated");
    expect(s.verifiedN).toBeCloseTo(2, 9);
    expect(s.verifiedScore!).toBeCloseTo(expectedScore(0, 2), 9);
  });

  // (c-3) "unknown" is a real DefectClass value (not undefined) and is NOT in
  // the excluded set — it must count. Distinct from undefined; both count.
  test("'unknown' defectClass counts at full weight", () => {
    const s = scoreSkill("skill_x", "x", [failure("unknown"), failure("unknown")], NOW);
    expect(s.verifiedN).toBeCloseTo(2, 9);
    expect(s.verifiedScore!).toBeCloseTo(expectedScore(0, 2), 9);
  });

  // The objective-non-attributable exclusion must be SCOPED to objective rows.
  // A user_feedback failure carrying attributable:false must STILL count (the
  // exclusion clause is `source === "objective" && attributable === false`).
  test("attributable:false only excludes OBJECTIVE failures, not user_feedback ones", () => {
    const objExcluded = scoreSkill(
      "skill_x",
      "x",
      [
        failure("skill_defect", { source: "objective", attributable: false }),
        failure("skill_defect", { source: "objective", attributable: false })
      ],
      NOW
    );
    // Objective + attributable:false -> excluded -> empty verified set.
    expect(objExcluded.verifiedN).toBe(0);

    // user_feedback failure with attributable:false -> NOT excluded by that
    // clause; counts at the 1.5 user-feedback weight.
    const ufKept = scoreSkill(
      "skill_x",
      "x",
      [
        failure("skill_defect", { source: "user_feedback", attributable: false }),
        failure("skill_defect", { source: "user_feedback", attributable: false })
      ],
      NOW
    );
    expect(ufKept.verifiedN).toBeCloseTo(2 * UF_W, 6);
    expect(ufKept.tier).not.toBe("unrated");
    // sumW = 3, sumWV = 0 -> 100 * 2.8 / (4 + 3) = 40.0 exactly.
    expect(ufKept.verifiedScore!).toBeCloseTo((100 * PRIOR_A0) / (PRIOR_A0 + PRIOR_B0 + 2 * UF_W), 9);
  });

  // (d) The UNRATED gate is verifiedN < 2 strictly. A SINGLE verified objective
  // success (verifiedN = 1) must read UNRATED, not flash a number.
  test("a single verified success reads UNRATED (verifiedN=1 < 2)", () => {
    const s = scoreSkill("skill_x", "x", [objSuccessVerified()], NOW);
    expect(s.tier).toBe("unrated");
    expect(s.verifiedScore).toBeNull();
    expect(s.verifiedN).toBeCloseTo(1, 9);
  });

  // Boundary: verifiedN exactly 2 (two objective successes) is rated, not
  // unrated. The gate is `< 2`, so 2 must pass.
  test("verifiedN exactly 2 is rated (boundary, not unrated)", () => {
    const s = scoreSkill("skill_x", "x", [objSuccessVerified(), objSuccessVerified()], NOW);
    expect(s.tier).not.toBe("unrated");
    expect(s.verifiedScore).not.toBeNull();
    expect(s.verifiedN).toBeCloseTo(2, 9);
  });

  // Adversarial: ONE fresh user_feedback success has weight 1.5 < 2, so it must
  // STILL be unrated despite being a strong human verdict. A regression that
  // counts heads instead of weight would wrongly rate it.
  test("one user_feedback success (weight 1.5) is below the rating gate -> UNRATED", () => {
    const s = scoreSkill("skill_x", "x", [ufSuccess()], NOW);
    expect(s.verifiedN).toBeCloseTo(UF_W, 6);
    expect(s.tier).toBe("unrated");
    expect(s.verifiedScore).toBeNull();
  });

  // (e) The reliable-cap. Build a high raw score from verified successes, but
  // make consequential coverage thin and unverified work dominate. It must NOT
  // read "reliable". Then prove the cap is conditional: a skill that earns
  // coverage (answered feedback) keeps "reliable".
  test("reliable-cap demotes a barely-adjudicated side-effecting skill", () => {
    const outcomes: SkillOutcome[] = [];
    for (let i = 0; i < 6; i++) outcomes.push(objSuccessVerified()); // verifiedN=6 -> raw >= 85
    for (let i = 0; i < 10; i++) outcomes.push(unverifiedConsequentialSuccess()); // coverage 0
    const s = scoreSkill("skill_x", "x", outcomes, NOW);
    expect(s.verifiedScore!).toBeGreaterThanOrEqual(85);
    expect(s.coverage).toBeLessThan(0.5);
    expect(s.unverifiedConsequentialN).toBeGreaterThan(s.verifiedN);
    expect(s.tier).toBe("works-unverified"); // capped, not reliable
  });

  test("the cap is conditional: enough answered feedback keeps 'reliable'", () => {
    // Same raw-score backbone but the consequential work is mostly adjudicated
    // (answered user_feedback successes), so coverage >= 0.5 and the cap is off.
    const outcomes: SkillOutcome[] = [];
    for (let i = 0; i < 6; i++) outcomes.push(objSuccessVerified());
    // 8 answered consequential successes (coverage numerator+denominator),
    // 2 unverified consequential (denominator only) -> coverage 0.8.
    for (let i = 0; i < 8; i++) outcomes.push(ufSuccess());
    for (let i = 0; i < 2; i++) outcomes.push(unverifiedConsequentialSuccess());
    const s = scoreSkill("skill_x", "x", outcomes, NOW);
    expect(s.coverage).toBeCloseTo(0.8, 9);
    expect(s.verifiedScore!).toBeGreaterThanOrEqual(85);
    expect(s.tier).toBe("reliable");
  });

  // The cap requires BOTH coverage<0.5 AND unverified>verifiedN. If coverage is
  // thin but unverified does NOT dominate, "reliable" should stand (no false
  // demotion). Pins the AND, guarding against an over-eager cap.
  test("cap does not fire when unverified work does not dominate verifiedN", () => {
    const outcomes: SkillOutcome[] = [];
    // 12 verified objective successes -> verifiedN=12, raw score very high.
    for (let i = 0; i < 12; i++) outcomes.push(objSuccessVerified());
    // Only 3 unverified consequential successes -> coverage 0 (<0.5) BUT
    // unverified (3) < verifiedN (12), so the cap must NOT fire.
    for (let i = 0; i < 3; i++) outcomes.push(unverifiedConsequentialSuccess());
    const s = scoreSkill("skill_x", "x", outcomes, NOW);
    expect(s.coverage).toBe(0);
    expect(s.unverifiedConsequentialN).toBeLessThan(s.verifiedN);
    expect(s.verifiedScore!).toBeGreaterThanOrEqual(85);
    expect(s.tier).toBe("reliable");
  });

  // (f) Coverage uses ANSWERED user_feedback rows, never feedbackPrompted. A
  // wall of prompted-but-unanswered consequential successes must read coverage
  // 0, never inflate it just because a prompt was sent.
  test("coverage ignores feedbackPrompted; only answered user_feedback counts", () => {
    const outcomes: SkillOutcome[] = [];
    // 10 consequential objective successes that were prompted but NOT answered.
    for (let i = 0; i < 10; i++) {
      outcomes.push(unverifiedConsequentialSuccess({ feedbackPrompted: true }));
    }
    // 2 verified objective successes so it's rated at all.
    outcomes.push(objSuccessVerified());
    outcomes.push(objSuccessVerified());
    const s = scoreSkill("skill_x", "x", outcomes, NOW);
    // 0 answered / 10 consequential = coverage 0, prompts notwithstanding.
    expect(s.coverage).toBe(0);
  });

  // Coverage denominator is consequential HEADS (undecayed), not weights, and a
  // user_feedback FAILURE that is consequential still counts as adjudicated
  // (source === "user_feedback"), because a human adjudicated it.
  test("a consequential user_feedback FAILURE counts as adjudicated coverage", () => {
    const outcomes: SkillOutcome[] = [
      // One consequential objective success (unadjudicated).
      unverifiedConsequentialSuccess(),
      // One consequential user_feedback failure: human said "wrong" -> adjudicated.
      failure("skill_defect", { source: "user_feedback", consequential: true, selfVerifiable: false }),
      // Pad the verified set so it's rated (2 objective successes).
      objSuccessVerified(),
      objSuccessVerified()
    ];
    const s = scoreSkill("skill_x", "x", outcomes, NOW);
    // 1 adjudicated (the uf failure) / 2 consequential = 0.5.
    expect(s.coverage).toBeCloseTo(0.5, 9);
  });

  // (g) Recency decay actually down-weights old outcomes. A 30-day-old success
  // (half-life) must contribute ~0.5 of its weight to verifiedN, and a 90-day
  // success ~0.125. Pins the exponential, not just "decayed > fresh".
  test("recency decay applies the 30-day half-life to verifiedN exactly", () => {
    const at30 = new Date(NOW - 30 * DAY).toISOString();
    const at90 = new Date(NOW - 90 * DAY).toISOString();
    const fresh = scoreSkill(
      "skill_x",
      "x",
      [objSuccessVerified(), objSuccessVerified()],
      NOW
    ).verifiedN;
    expect(fresh).toBeCloseTo(2, 9);

    // Two successes 30 days old: each weight 0.5 -> verifiedN ~1.0.
    const s30 = scoreSkill(
      "skill_x",
      "x",
      [objSuccessVerified({ createdAt: at30 }), objSuccessVerified({ createdAt: at30 })],
      NOW
    );
    expect(s30.verifiedN).toBeCloseTo(1.0, 6);
    // verifiedN now < 2 -> the decay tipped it into UNRATED. Old evidence can't
    // keep a stale skill rated forever.
    expect(s30.tier).toBe("unrated");
    expect(s30.verifiedScore).toBeNull();

    // 90 days = 3 half-lives -> weight 0.125 each.
    const s90 = scoreSkill(
      "skill_x",
      "x",
      [objSuccessVerified({ createdAt: at90 })],
      NOW
    );
    expect(s90.verifiedN).toBeCloseTo(0.125, 6);
  });

  // Recency decay must symmetrically fade old FAILURES too — verified by score
  // movement: old failures + fresh successes score higher than the reverse.
  test("decay fades old failures relative to fresh ones (asymmetry across age)", () => {
    const old = new Date(NOW - 120 * DAY).toISOString(); // 4 half-lives -> 1/16
    const oldFailFreshWin = scoreSkill(
      "skill_x",
      "x",
      [
        failure("skill_defect", { createdAt: old }),
        failure("skill_defect", { createdAt: old }),
        ufSuccess(),
        ufSuccess()
      ],
      NOW
    ).verifiedScore!;
    const freshFailFreshWin = scoreSkill(
      "skill_x",
      "x",
      [failure("skill_defect"), failure("skill_defect"), ufSuccess(), ufSuccess()],
      NOW
    ).verifiedScore!;
    expect(oldFailFreshWin).toBeGreaterThan(freshFailFreshWin);
  });

  // (h) The headline honesty case: a 100%-silently-wrong consequential skill —
  // many !selfVerifiable consequential "successes", ZERO human feedback, no
  // objective verification. It must NOT read healthy/reliable. With no verified
  // evidence it must be UNRATED (we know nothing), never a green number.
  test("a 100%-unverified consequential skill reads UNRATED, never healthy", () => {
    const outcomes: SkillOutcome[] = [];
    for (let i = 0; i < 40; i++) outcomes.push(unverifiedConsequentialSuccess());
    const s = scoreSkill("skill_x", "x", outcomes, NOW);
    expect(s.verifiedN).toBe(0);
    expect(s.tier).toBe("unrated");
    expect(s.verifiedScore).toBeNull();
    expect(s.coverage).toBe(0); // 0 adjudicated / 40 consequential
    expect(s.unverifiedConsequentialN).toBeCloseTo(40, 6);
    // Critically: tier is never "reliable"/"works-unverified" for this skill.
    expect(["reliable", "works-unverified"]).not.toContain(s.tier);
  });

  // Mixed adversary: a side-effecting skill with a FEW verified objective
  // successes (just enough to clear the gate) but overwhelmingly unverified
  // consequential work AND zero coverage must be capped — never "reliable".
  test("thin verified evidence + dominant unverified consequential work is capped", () => {
    const outcomes: SkillOutcome[] = [];
    // Exactly enough verified successes to push raw >= 85 (6 -> 86.67) while the
    // consequential work (50 unverified) dwarfs it. coverage 0, unverified >> N.
    for (let i = 0; i < 6; i++) outcomes.push(objSuccessVerified());
    for (let i = 0; i < 50; i++) outcomes.push(unverifiedConsequentialSuccess());
    const s = scoreSkill("skill_x", "x", outcomes, NOW);
    expect(s.verifiedScore!).toBeGreaterThanOrEqual(85);
    expect(s.tier).not.toBe("reliable");
    expect(s.tier).toBe("works-unverified");
  });

  // Robustness: an unparseable createdAt must not produce NaN weights. The
  // source falls back to nowMs for the decay age; verify the score is finite
  // and the rows still count at full (fresh) weight.
  test("an unparseable createdAt does not poison the score with NaN", () => {
    const bad = scoreSkill(
      "skill_x",
      "x",
      [
        objSuccessVerified({ createdAt: "not-a-date" }),
        objSuccessVerified({ createdAt: "not-a-date" })
      ],
      NOW
    );
    expect(Number.isFinite(bad.verifiedN)).toBe(true);
    expect(Number.isFinite(bad.verifiedScore!)).toBe(true);
    // Treated as fresh (age 0) -> full weight, verifiedN ~2.
    expect(bad.verifiedN).toBeCloseTo(2, 9);
  });

  // Ordering invariance: the score is a sum, so shuffling the outcome order
  // must not change any field. Guards against an accidental order-dependent
  // accumulation bug.
  test("outcome ordering does not affect the score", () => {
    const rows = [
      failure("skill_defect"),
      objSuccessVerified(),
      unverifiedConsequentialSuccess(),
      ufSuccess(),
      failure("environment"),
      objSuccessVerified()
    ];
    const a = scoreSkill("skill_x", "x", rows, NOW);
    const b = scoreSkill("skill_x", "x", [...rows].reverse(), NOW);
    expect(b.verifiedScore!).toBeCloseTo(a.verifiedScore!, 12);
    expect(b.verifiedN).toBeCloseTo(a.verifiedN, 12);
    expect(b.unverifiedConsequentialN).toBeCloseTo(a.unverifiedConsequentialN, 12);
    expect(b.coverage).toBeCloseTo(a.coverage, 12);
    expect(b.tier).toBe(a.tier);
  });

  // Coverage with zero consequential rows must be 1 (vacuously fully covered),
  // never NaN (0/0). A non-consequential skill is not penalized on coverage.
  test("coverage is 1 (not NaN) when there are no consequential rows", () => {
    const s = scoreSkill(
      "skill_x",
      "x",
      [objSuccessVerified(), objSuccessVerified(), failure("skill_defect")],
      NOW
    );
    expect(s.coverage).toBe(1);
    expect(Number.isNaN(s.coverage)).toBe(false);
  });

  // The verifiedScore must be bounded [0,100] even under extreme inputs. Many
  // verified successes approach but never exceed 100; many failures approach 0.
  test("verifiedScore stays within [0,100] at extremes", () => {
    const allWin = scoreSkill(
      "skill_x",
      "x",
      Array.from({ length: 200 }, () => objSuccessVerified()),
      NOW
    );
    expect(allWin.verifiedScore!).toBeLessThanOrEqual(100);
    expect(allWin.verifiedScore!).toBeGreaterThan(85);

    const allLose = scoreSkill(
      "skill_x",
      "x",
      Array.from({ length: 200 }, () => failure("skill_defect")),
      NOW
    );
    expect(allLose.verifiedScore!).toBeGreaterThanOrEqual(0);
    expect(allLose.verifiedScore!).toBeLessThan(5);
  });
});

describe("computeSkillScores — read-path over durable state", () => {
  // computeSkillScores scores against the live wall clock (no injectable nowMs),
  // so durable rows must be stamped "now" to avoid spurious recency decay.
  function freshObjSuccess(extra: Partial<SkillOutcome> = {}): SkillOutcome {
    return objSuccessVerified({ createdAt: new Date().toISOString(), ...extra });
  }
  function freshUnverifiedConsequential(extra: Partial<SkillOutcome> = {}): SkillOutcome {
    return unverifiedConsequentialSuccess({ createdAt: new Date().toISOString(), ...extra });
  }

  // Rows with no skillId belong to the unattributed bucket and must NOT appear
  // as a skill score. Only attributed outcomes produce a score.
  test("skips the unattributed (no skillId) bucket entirely", async () => {
    const instance = "score-probe-unattributed";
    const config = makeConfig(instance);
    readState(instance);
    await mutateState(instance, (state) => {
      // Two attributed successes for skill_a.
      state.skillOutcomes.push(
        freshObjSuccess({ skillId: "skill_a", skillName: "alpha" }),
        freshObjSuccess({ skillId: "skill_a", skillName: "alpha" }),
        // An unattributed failure row (no skillId) — must be ignored.
        failure("skill_defect", { skillId: undefined, skillName: undefined }) as SkillOutcome
      );
    });
    const scores = computeSkillScores(config);
    expect(scores).toHaveLength(1);
    expect(scores[0]!.skillId).toBe("skill_a");
    // verifiedN ~2 (rows stamped now); allow a sliver of clock skew.
    expect(scores[0]!.verifiedN).toBeGreaterThan(1.99);
    expect(scores[0]!.verifiedN).toBeLessThanOrEqual(2.0001);
  });

  // Name resolution prefers state.skills; falls back to the outcome's skillName.
  test("resolves display name from state.skills, falling back to outcome.skillName", async () => {
    const instance = "score-probe-names";
    const config = makeConfig(instance);
    readState(instance);
    await mutateState(instance, (state) => {
      const sk = createSkill(state, {
        name: "Canonical Name",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled"
      });
      state.skillOutcomes.push(
        freshObjSuccess({ skillId: sk.id, skillName: "stale-outcome-name" }),
        freshObjSuccess({ skillId: sk.id, skillName: "stale-outcome-name" }),
        // A skill present only via outcomes (no state.skills row) -> name falls
        // back to the outcome's skillName.
        freshObjSuccess({ skillId: "skill_orphan", skillName: "orphan-name" }),
        freshObjSuccess({ skillId: "skill_orphan", skillName: "orphan-name" })
      );
    });
    const scores = computeSkillScores(config);
    const canonical = scores.find((s) => s.skillId !== "skill_orphan")!;
    const orphan = scores.find((s) => s.skillId === "skill_orphan")!;
    expect(canonical.skillName).toBe("Canonical Name"); // state.skills wins
    expect(orphan.skillName).toBe("orphan-name"); // falls back to outcome name
  });

  // End-to-end honesty through the durable read-path: a skill whose ONLY rows
  // are unverified consequential successes must read UNRATED out of state — the
  // false-green guarantee survives the state layer, not just the pure function.
  test("a silently-unverified skill reads UNRATED through computeSkillScores", async () => {
    const instance = "score-probe-silent";
    const config = makeConfig(instance);
    readState(instance);
    await mutateState(instance, (state) => {
      for (let i = 0; i < 20; i++) {
        state.skillOutcomes.push(
          freshUnverifiedConsequential({ skillId: "skill_silent", skillName: "silent" })
        );
      }
    });
    const scores = computeSkillScores(config);
    expect(scores).toHaveLength(1);
    expect(scores[0]!.tier).toBe("unrated");
    expect(scores[0]!.verifiedScore).toBeNull();
  });
});
