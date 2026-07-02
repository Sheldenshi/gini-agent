// Read-only skill reliability score (ADR skill-learning-from-outcomes.md).
//
// A purely OBSERVATIONAL, human-facing indicator derived from a skill's
// SkillOutcome history. It gates NOTHING and nothing in the runtime reads it
// for control flow — no auto-apply, no proposal gating. It exists so a human
// reviewer can eyeball "is this skill earning its keep?" with an honest number.
//
// The honesty guarantees are encoded directly in the rules below:
//  - a failure only counts against a skill when it is the SKILL's fault
//    (environment/credential/transient defects, and non-attributable objective
//    failures, are excluded; unclassified failures are KEPT — a skill earns
//    exclusion, it doesn't get it for free by sitting unreviewed);
//  - the rate is computed over a VERIFIED set only (objective successes that
//    aren't self-verifiable never raise it);
//  - a skill with too little verified evidence reads "unrated", never a number;
//  - a side-effecting skill we've barely adjudicated is capped below "reliable".

import type { RuntimeConfig, SkillOutcome } from "../types";
import { readState } from "../state";

export interface SkillScore {
  skillId: string;
  skillName?: string;
  tier: "unrated" | "struggling" | "unproven" | "works-unverified" | "reliable";
  // 0-100; null exactly when tier === "unrated".
  verifiedScore: number | null;
  // Effective (recency-weighted) count in the verified set.
  verifiedN: number;
  // Consequential successes we could NOT verify (recency-weighted). Never raises
  // the score; surfaced so a reviewer sees how much is riding on unverified work.
  unverifiedConsequentialN: number;
  // 0-1: adjudicated consequential / total consequential (1 when none consequential).
  coverage: number;
}

// Recency decay: a half-life of 30 days. An outcome's weight is multiplied by
// 0.5 ^ (age_days / 30), so a month-old signal counts half as much as a fresh one.
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

// Bayesian prior: mean 0.70, strength k=4 -> a0 = 0.70*4 = 2.8, b0 = 0.30*4 = 1.2.
// New skills start optimistic-but-soft; ~2 verified observations move the needle.
const PRIOR_A0 = 2.8;
const PRIOR_B0 = 1.2;

// user_feedback outcomes weigh more than objective ones — a human verdict is the
// strongest correctness signal this runtime has.
const USER_FEEDBACK_WEIGHT = 1.5;
const OBJECTIVE_WEIGHT = 1.0;

// A failure counts against the score ONLY when it is the skill's fault. These
// defect classes are environmental, not the body's fault, so they're excluded.
// Note: `unknown` and `undefined` (unclassified) are deliberately NOT here — a
// skill earns exclusion by being classified out, never by sitting unreviewed.
const EXCLUDED_DEFECT_CLASSES = new Set(["environment", "credential", "transient"]);

function decayWeight(baseWeight: number, createdAtMs: number, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - createdAtMs);
  return baseWeight * Math.pow(0.5, ageMs / HALF_LIFE_MS);
}

// Does this failure count against the score? (rule 1)
function failureCountsAgainst(o: SkillOutcome): boolean {
  // An objective failure the reflection judged non-attributable is excluded.
  if (o.source === "objective" && o.attributable === false) return false;
  // Classified-environmental failures are excluded; everything else (skill_defect,
  // model_ignored, unknown, AND unclassified/undefined) is kept at full weight.
  if (o.defectClass !== undefined && EXCLUDED_DEFECT_CLASSES.has(o.defectClass)) return false;
  return true;
}

// Score a single skill's outcomes. `nowMs` is injectable for deterministic tests;
// it defaults to the current wall clock (this is not a workflow script).
export function scoreSkill(
  skillId: string,
  skillName: string | undefined,
  outcomes: SkillOutcome[],
  nowMs: number = Date.now()
): SkillScore {
  // --- Verified set (rule 2): the rate is computed over THIS set only. ---
  // Each entry carries its recency-decayed weight `w` and verified outcome `v`.
  let sumW = 0; // Σ w
  let sumWV = 0; // Σ w·v
  let unverifiedConsequentialN = 0; // recency-weighted unverified consequential successes (rule 3)

  // --- Coverage (rule 6) ---
  let totalConsequential = 0;
  let adjudicatedConsequential = 0;

  for (const o of outcomes) {
    const createdAtMs = Date.parse(o.createdAt);
    const ageMsKnown = Number.isFinite(createdAtMs);

    // Coverage counts heads, not weights: how much consequential work has a human
    // actually adjudicated (an ANSWERED user_feedback row, not merely a prompt).
    if (o.consequential) {
      totalConsequential += 1;
      if (o.source === "user_feedback") adjudicatedConsequential += 1;
    }

    if (o.signal === "failure") {
      if (!failureCountsAgainst(o)) continue;
      const base = o.source === "user_feedback" ? USER_FEEDBACK_WEIGHT : OBJECTIVE_WEIGHT;
      const w = decayWeight(base, ageMsKnown ? createdAtMs : nowMs, nowMs);
      sumW += w; // v = 0, so sumWV unchanged
      continue;
    }

    // signal === "success"
    if (o.source === "user_feedback") {
      // A human "right" verdict — a verified success (v=1).
      const w = decayWeight(USER_FEEDBACK_WEIGHT, ageMsKnown ? createdAtMs : nowMs, nowMs);
      sumW += w;
      sumWV += w;
      continue;
    }

    // source === "objective" success.
    if (o.selfVerifiable) {
      // A verifiable objective success (v=1) — e.g. a non-consequential run that
      // an objective signal confirmed.
      const w = decayWeight(OBJECTIVE_WEIGHT, ageMsKnown ? createdAtMs : nowMs, nowMs);
      sumW += w;
      sumWV += w;
    } else {
      // An UNVERIFIED consequential success (rule 3): NOT in the verified set, so
      // it can never raise the score. Counted only for the reviewer's awareness.
      unverifiedConsequentialN += decayWeight(
        OBJECTIVE_WEIGHT,
        ageMsKnown ? createdAtMs : nowMs,
        nowMs
      );
    }
  }

  const verifiedN = sumW;
  const coverage = totalConsequential === 0 ? 1 : adjudicatedConsequential / totalConsequential;

  // --- UNRATED gate (rule 5): never emit a number we didn't earn. ---
  if (verifiedN < 2) {
    return {
      skillId,
      skillName,
      tier: "unrated",
      verifiedScore: null,
      verifiedN,
      unverifiedConsequentialN,
      coverage
    };
  }

  // --- verifiedScore (rule 4): Bayesian-smoothed rate over the verified set. ---
  const score = (100 * (PRIOR_A0 + sumWV)) / (PRIOR_A0 + PRIOR_B0 + sumW);

  // --- Band the score (rule 5), capping a barely-adjudicated side-effecting skill. ---
  let tier: SkillScore["tier"];
  if (score < 40) tier = "struggling";
  else if (score < 70) tier = "unproven";
  else if (score < 85) tier = "works-unverified";
  else tier = "reliable";

  // A side-effecting skill we've barely adjudicated can't read "reliable":
  // cap at works-unverified when coverage is thin AND unverified work dominates.
  if (tier === "reliable" && coverage < 0.5 && unverifiedConsequentialN > verifiedN) {
    tier = "works-unverified";
  }

  return {
    skillId,
    skillName,
    tier,
    verifiedScore: score,
    verifiedN,
    unverifiedConsequentialN,
    coverage
  };
}

// Group durable skillOutcomes by skillId (skipping the unattributed/no-skillId
// bucket) and score each, resolving the display name from state.skills. The
// result is a read-only indicator list for the human review surfaces.
export function computeSkillScores(config: RuntimeConfig): SkillScore[] {
  const state = readState(config.instance);
  const bySkill = new Map<string, SkillOutcome[]>();
  for (const o of state.skillOutcomes) {
    if (!o.skillId) continue; // unattributed bucket is not a skill
    const list = bySkill.get(o.skillId);
    if (list) list.push(o);
    else bySkill.set(o.skillId, [o]);
  }
  const scores: SkillScore[] = [];
  for (const [skillId, outcomes] of bySkill) {
    const name =
      state.skills.find((s) => s.id === skillId)?.name ??
      outcomes.find((o) => o.skillName)?.skillName;
    scores.push(scoreSkill(skillId, name, outcomes));
  }
  return scores;
}
