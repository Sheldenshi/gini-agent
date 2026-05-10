// Hindsight phase 4 — opinion reinforcement (paper Eq. 25-26).
//
// When retain inserts a new fact, walk the bank's existing opinions and ask
// the LLM whether the fact reinforces, weakens, contradicts, or is neutral
// relative to each. Apply the Eq. 26 confidence delta:
//
//   reinforce  -> confidence += α-step (clamped to [0,1])
//   weaken     -> confidence -= α-step (clamped to [0,1])
//   contradict -> confidence -> -confidence (effectively 1 - confidence)
//   neutral    -> no change
//
// α-step = 0.1 (brief tuning constants).
//
// Eq. 25 candidate set: opinions whose text shares an entity with the new
// fact, OR whose embedding is sufficiently close (cosine ≥ 0.6). Capped at
// 8 candidates per fact to bound LLM cost.
//
// Adapted from vectorize-io/hindsight (MIT). The candidate-set heuristic
// matches upstream; thresholds tuned per the brief.

import type { RuntimeConfig } from "../types";
import type {
  HindsightMemoryUnit as MemoryUnit
} from "../state";
import {
  appendTrace,
  entityMentionsForUnit,
  listMemoryUnits,
  unitsForEntity,
  updateMemoryUnitConfidence
} from "../state";
import { generateStructured } from "../provider";
import { cosineSimilarity } from "../embeddings";
import {
  opinionAssessmentValidator,
  type AssessmentVerdict
} from "./schemas";

export const ALPHA_STEP = 0.1;
export const REINFORCE_SEMANTIC_THRESHOLD = 0.6;
export const MAX_CANDIDATES_PER_FACT = 8;

const ASSESSMENT_SYSTEM = `You assess whether a new fact reinforces, weakens, contradicts, or is neutral relative to a stored opinion. Output strict JSON: { "verdict": "reinforce" | "weaken" | "contradict" | "neutral", "reasoning": "..." }.`;

const ASSESSMENT_USER_TEMPLATE = (opinionText: string, factText: string) =>
  `STORED OPINION:\n"""${opinionText}"""\n\nNEW FACT:\n"""${factText}"""\n\nDoes the new fact reinforce, weaken, contradict, or stay neutral relative to the opinion? Be strict.`;

export async function reinforceOpinionsForUnits(
  config: RuntimeConfig,
  bankId: string,
  units: MemoryUnit[]
): Promise<void> {
  if (units.length === 0) return;
  const instance = config.instance;
  for (const unit of units) {
    // Only facts (world/experience) trigger reinforcement; skip opinions
    // and observations to avoid feedback loops.
    if (unit.network !== "world" && unit.network !== "experience") continue;
    const candidates = collectCandidates(instance, bankId, unit);
    if (candidates.length === 0) continue;
    for (const opinion of candidates) {
      try {
        const result = await generateStructured(config, {
          system: ASSESSMENT_SYSTEM,
          user: ASSESSMENT_USER_TEMPLATE(opinion.text, unit.text),
          schemaName: "OpinionAssessment",
          validator: opinionAssessmentValidator,
          echoTag: `assess:${opinion.id}`
        });
        const before = opinion.confidence ?? 0.5;
        const after = applyVerdict(before, result.data.verdict);
        if (after !== before) {
          updateMemoryUnitConfidence(instance, opinion.id, after);
          appendTrace(instance, unit.sourceTaskId ?? bankId, {
            type: "memory",
            message: "opinion confidence updated",
            data: {
              opinionId: opinion.id,
              factId: unit.id,
              verdict: result.data.verdict,
              before,
              after
            }
          });
        }
      } catch {
        // Swallow per-candidate errors — reinforcement is best-effort.
      }
    }
  }
}

export function applyVerdict(confidence: number, verdict: AssessmentVerdict): number {
  switch (verdict) {
    case "reinforce":
      return clamp01(confidence + ALPHA_STEP);
    case "weaken":
      return clamp01(confidence - ALPHA_STEP);
    case "contradict":
      // Eq. 26 contradict: flip the confidence around 0.5. A near-1.0 opinion
      // becomes near-0; a 0.5 opinion stays at 0.5.
      return clamp01(1 - confidence);
    case "neutral":
    default:
      return confidence;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// Eq. 25: opinions that share an entity OR have semantic-similar text.
function collectCandidates(
  instance: string,
  bankId: string,
  newUnit: MemoryUnit
): MemoryUnit[] {
  const seen = new Map<string, MemoryUnit>();

  // Entity-shared candidates.
  const mentions = entityMentionsForUnit(instance, newUnit.id);
  for (const mention of mentions) {
    for (const candidate of unitsForEntity(instance, mention.entityId, MAX_CANDIDATES_PER_FACT)) {
      if (candidate.network !== "opinion") continue;
      seen.set(candidate.id, candidate);
    }
  }

  // Semantic-similar candidates over the active opinion pool.
  if (newUnit.embedding) {
    const opinionPool = listMemoryUnits(instance, bankId, { network: "opinion", limit: 50 });
    for (const candidate of opinionPool) {
      if (seen.has(candidate.id)) continue;
      if (!candidate.embedding) continue;
      if (candidate.embedding.length !== newUnit.embedding.length) continue;
      const sim = cosineSimilarity(newUnit.embedding, candidate.embedding);
      if (sim < REINFORCE_SEMANTIC_THRESHOLD) continue;
      seen.set(candidate.id, candidate);
    }
  }

  // Cap to MAX_CANDIDATES_PER_FACT.
  return [...seen.values()].slice(0, MAX_CANDIDATES_PER_FACT);
}
