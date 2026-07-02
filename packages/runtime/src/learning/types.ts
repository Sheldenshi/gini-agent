// Skill learning from task outcomes (ADR skill-learning-from-outcomes.md).
//
// The durable row shapes (SkillOutcome, LearningFinding, SkillEditOp and the
// signal/source/defect enums) live in src/types.ts alongside RuntimeState so
// the state layer can persist them. This module re-exports them under the
// `src/learning` namespace and adds the two shapes that never hit durable
// state: the result of applying edits, and the reflection LLM's structured
// verdict.

export type {
  SkillOutcome,
  LearningFinding,
  SkillEditOp,
  OutcomeSignal,
  OutcomeSource,
  DefectClass
} from "../types";

import type { SkillEditOp, DefectClass } from "../types";

// Result of applying a batch of edits to a skill body. `skipped` records the
// ops whose anchor/target didn't match so the caller can surface them without
// the edit pass throwing.
export interface ApplyEditsResult {
  body: string;
  applied: number;
  skipped: SkillEditOp[];
}

// The reflection pass's structured LLM verdict for one skill's failure batch.
// `attributable` is the model's own confidence that the failures trace to the
// skill body (vs. environment/credential/model). `nonSkillFinding` carries a
// human-readable summary when the verdict routes to a finding instead of an edit.
export interface ReflectionVerdict {
  defectClass: DefectClass;
  attributable: boolean;
  edits: SkillEditOp[];
  rationale: string;
  nonSkillFinding?: string;
}
