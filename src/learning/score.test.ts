// Read-only skill reliability score (ADR skill-learning-from-outcomes.md).
//
// Each test pins one honesty rule from scoreSkill:
//  - a new/empty skill is unrated (no number we didn't earn);
//  - environmental failures don't drag the score (they aren't the skill's fault);
//  - skill_defect and UNCLASSIFIED failures DO count (exclusion must be earned);
//  - unverified consequential successes never raise the score;
//  - a human "right" verdict raises it;
//  - recency decay fades old failures;
//  - a barely-adjudicated side-effecting skill is capped below "reliable".

import { describe, expect, test } from "bun:test";
import { scoreSkill } from "./score";
import type { DefectClass, OutcomeSource, SkillOutcome } from "../types";

const NOW = Date.parse("2026-06-16T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

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
    // Default to "now" so undecayed unless a test overrides createdAt.
    createdAt: new Date(NOW).toISOString(),
    ...partial
  };
}

function failure(defectClass?: DefectClass, extra: Partial<SkillOutcome> = {}): SkillOutcome {
  return outcome({ signal: "failure", selfVerifiable: true, defectClass, ...extra });
}

describe("scoreSkill", () => {
  test("a new/empty skill is unrated, not a number", () => {
    const s = scoreSkill("skill_x", "x", [], NOW);
    expect(s.tier).toBe("unrated");
    expect(s.verifiedScore).toBeNull();
    expect(s.verifiedN).toBe(0);
    expect(s.coverage).toBe(1);
  });

  test("environment failures leave the skill unrated, NOT struggling", () => {
    const s = scoreSkill(
      "skill_x",
      "x",
      [failure("environment"), failure("environment")],
      NOW
    );
    // Both failures are excluded, so the verified set is empty -> unrated.
    expect(s.tier).toBe("unrated");
    expect(s.verifiedScore).toBeNull();
    expect(s.verifiedN).toBe(0);
  });

  test("credential and transient failures are also excluded", () => {
    const s = scoreSkill("skill_x", "x", [failure("credential"), failure("transient")], NOW);
    expect(s.tier).toBe("unrated");
    expect(s.verifiedN).toBe(0);
  });

  test("two skill_defect failures pull the score well below the prior", () => {
    // sumWV=0, sumW=2 -> 100 * (2.8 + 0) / (2.8 + 1.2 + 2) = 280/6 = 46.67.
    // Two clean failures move it from the 70 prior baseline into "unproven".
    const s = scoreSkill("skill_x", "x", [failure("skill_defect"), failure("skill_defect")], NOW);
    expect(s.tier).toBe("unproven");
    expect(s.verifiedScore).not.toBeNull();
    expect(s.verifiedScore!).toBeCloseTo(46.6667, 3);
    expect(s.verifiedN).toBeCloseTo(2, 5);
  });

  test("four skill_defect failures push the score into 'struggling'", () => {
    // 100 * 2.8 / (4 + 4) = 35 -> below 40.
    const fails = [
      failure("skill_defect"),
      failure("skill_defect"),
      failure("skill_defect"),
      failure("skill_defect")
    ];
    const s = scoreSkill("skill_x", "x", fails, NOW);
    expect(s.tier).toBe("struggling");
    expect(s.verifiedScore!).toBeLessThan(40);
  });

  test("two UNCLASSIFIED failures are counted (not excluded) — a skill earns exclusion", () => {
    // defectClass undefined: must be kept at full weight.
    const s = scoreSkill("skill_x", "x", [failure(undefined), failure(undefined)], NOW);
    expect(s.tier).not.toBe("unrated");
    expect(s.verifiedN).toBeCloseTo(2, 5);
    // Same math as two counted failures with no successes.
    expect(s.verifiedScore!).toBeLessThan(50);
  });

  test("unverified consequential successes never raise the score and lower coverage", () => {
    // A baseline: two counted failures fix a (low) verified score.
    const base = [failure("skill_defect"), failure("skill_defect")];
    const baseScore = scoreSkill("skill_x", "x", base, NOW).verifiedScore!;

    // Add three UNVERIFIED consequential successes (objective, !selfVerifiable).
    const withUnverified = [
      ...base,
      outcome({ signal: "success", source: "objective", consequential: true, selfVerifiable: false }),
      outcome({ signal: "success", source: "objective", consequential: true, selfVerifiable: false }),
      outcome({ signal: "success", source: "objective", consequential: true, selfVerifiable: false })
    ];
    const s = scoreSkill("skill_x", "x", withUnverified, NOW);

    // verifiedScore is UNCHANGED — the unverified successes are outside the set.
    expect(s.verifiedScore!).toBeCloseTo(baseScore, 5);
    expect(s.unverifiedConsequentialN).toBeCloseTo(3, 5);
    // 0 adjudicated / 3 consequential = coverage 0.
    expect(s.coverage).toBe(0);
    expect(s.coverage).toBeLessThan(1);
  });

  test("a user 'right' verdict raises the score", () => {
    const fails = [failure("skill_defect"), failure("skill_defect")];
    const before = scoreSkill("skill_x", "x", fails, NOW).verifiedScore!;
    const after = scoreSkill(
      "skill_x",
      "x",
      [
        ...fails,
        outcome({
          signal: "success",
          source: "user_feedback",
          consequential: true,
          selfVerifiable: false,
          feedbackPrompted: true
        })
      ],
      NOW
    ).verifiedScore!;
    expect(after).toBeGreaterThan(before);
  });

  test("recency decay fades old failures (old failures count less than fresh successes)", () => {
    // Two skill_defect failures 120 days ago (decayed by 0.5^4 = 1/16 each) plus
    // two fresh user 'right' verdicts. The decayed failures barely register.
    const old = new Date(NOW - 120 * DAY).toISOString();
    const decayed = scoreSkill(
      "skill_x",
      "x",
      [
        failure("skill_defect", { createdAt: old }),
        failure("skill_defect", { createdAt: old }),
        outcome({ signal: "success", source: "user_feedback", consequential: true, selfVerifiable: false }),
        outcome({ signal: "success", source: "user_feedback", consequential: true, selfVerifiable: false })
      ],
      NOW
    );

    // Same data but with the failures FRESH (not decayed) scores much lower.
    const fresh = scoreSkill(
      "skill_x",
      "x",
      [
        failure("skill_defect"),
        failure("skill_defect"),
        outcome({ signal: "success", source: "user_feedback", consequential: true, selfVerifiable: false }),
        outcome({ signal: "success", source: "user_feedback", consequential: true, selfVerifiable: false })
      ],
      NOW
    );

    expect(decayed.verifiedScore!).toBeGreaterThan(fresh.verifiedScore!);
  });

  test("a barely-adjudicated side-effecting skill is capped below 'reliable'", () => {
    // Enough verified successes to push the raw score >= 85, but the consequential
    // work is overwhelmingly UNVERIFIED (coverage < 0.5, unverified > verifiedN).
    const outcomes: SkillOutcome[] = [];
    // 5 verified objective successes (non-consequential) -> verifiedN = 5,
    // score = 100 * (2.8 + 5) / (4 + 5) = 86.67, which alone bands as "reliable".
    for (let i = 0; i < 5; i++) {
      outcomes.push(outcome({ signal: "success", source: "objective", consequential: false, selfVerifiable: true }));
    }
    // 10 unverified consequential successes -> coverage 0, unverified dominates.
    for (let i = 0; i < 10; i++) {
      outcomes.push(
        outcome({ signal: "success", source: "objective", consequential: true, selfVerifiable: false })
      );
    }
    const s = scoreSkill("skill_x", "x", outcomes, NOW);

    expect(s.verifiedScore!).toBeGreaterThanOrEqual(85);
    expect(s.coverage).toBeLessThan(0.5);
    expect(s.unverifiedConsequentialN).toBeGreaterThan(s.verifiedN);
    // The cap kicks in: it reads works-unverified, never reliable.
    expect(s.tier).toBe("works-unverified");
  });

  test("coverage counts ANSWERED feedback, not merely prompted", () => {
    const outcomes: SkillOutcome[] = [
      // A consequential success that was prompted but never answered (still objective).
      outcome({
        signal: "success",
        source: "objective",
        consequential: true,
        selfVerifiable: false,
        feedbackPrompted: true
      }),
      // A consequential success the user actually answered (user_feedback row).
      outcome({
        signal: "success",
        source: "user_feedback",
        consequential: true,
        selfVerifiable: false,
        feedbackPrompted: true
      })
    ];
    const s = scoreSkill("skill_x", "x", outcomes, NOW);
    // 1 adjudicated / 2 consequential = 0.5 — the prompted-but-unanswered row
    // does NOT count toward adjudicated.
    expect(s.coverage).toBe(0.5);
  });

  test("a non-attributable objective failure is excluded", () => {
    const s = scoreSkill(
      "skill_x",
      "x",
      [
        failure("skill_defect", { source: "objective", attributable: false }),
        failure("skill_defect", { source: "objective", attributable: false })
      ],
      NOW
    );
    expect(s.tier).toBe("unrated");
    expect(s.verifiedN).toBe(0);
  });
});
