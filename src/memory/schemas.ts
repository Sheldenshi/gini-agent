// Hindsight phase 2 — runtime validators for LLM structured output.
//
// Rather than pull in Zod we hand-roll narrow validators that match the
// Pydantic shapes from paper Appendix A.5 (FACT_SCHEMA, OPINION_SCHEMA,
// OBSERVATION_SCHEMA). Each `parse` throws on shape error so callers can
// retry-or-give-up uniformly.
//
// Adapted from vectorize-io/hindsight (MIT) — same field names + literals.

import type { StructuredValidator } from "../provider";
import type { EntityType } from "../state";

export type FactType = "world" | "experience" | "opinion";
export type CausalRelationType = "causes" | "caused_by" | "enables" | "prevents";

export interface ExtractedEntity {
  text: string;
  entity_type?: EntityType;
}

export interface ExtractedCausalRelation {
  target_fact_index: number;
  relation_type: CausalRelationType;
  strength: number;
}

export interface ExtractedFact {
  what: string;
  when: string;
  where: string;
  who: string;
  why: string;
  fact_type: FactType;
  occurred_start?: string | null;
  occurred_end?: string | null;
  mentioned_at?: string | null;
  entities?: ExtractedEntity[];
  causal_relations?: ExtractedCausalRelation[];
}

export interface FactExtractionResponse {
  facts: ExtractedFact[];
}

export interface ExtractedOpinion {
  opinion: string;
  confidence: number;
  reasoning: string;
}

export interface OpinionExtractionResponse {
  opinions: ExtractedOpinion[];
}

export interface ObservationExtractionResponse {
  observations: Array<{ observation: string }>;
}

export type AssessmentVerdict = "reinforce" | "weaken" | "contradict" | "neutral";

export interface OpinionAssessment {
  verdict: AssessmentVerdict;
  reasoning?: string;
}

const ENTITY_TYPES: EntityType[] = ["PERSON", "ORGANIZATION", "LOCATION", "PRODUCT", "CONCEPT", "OTHER"];
const FACT_TYPES: FactType[] = ["world", "experience", "opinion"];
const CAUSAL_TYPES: CausalRelationType[] = ["causes", "caused_by", "enables", "prevents"];
const ASSESSMENT_VERDICTS: AssessmentVerdict[] = ["reinforce", "weaken", "contradict", "neutral"];

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error("Expected object");
}
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error("Expected array");
}
function asString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new Error(`Field ${field} must be a string`);
}
function asNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Field ${field} must be a number`);
}
function asEnum<T extends string>(value: unknown, options: readonly T[], field: string): T {
  if (typeof value === "string" && (options as readonly string[]).includes(value)) return value as T;
  throw new Error(`Field ${field} must be one of: ${options.join(", ")}`);
}

export const factExtractionValidator: StructuredValidator<FactExtractionResponse> = {
  parse(value: unknown): FactExtractionResponse {
    const root = asObject(value);
    const factsRaw = root.facts;
    if (factsRaw === undefined) return { facts: [] };
    const facts = asArray(factsRaw).map((entry, index) => parseFact(entry, index));
    return { facts };
  }
};

function parseFact(value: unknown, index: number): ExtractedFact {
  const obj = asObject(value);
  const out: ExtractedFact = {
    what: typeof obj.what === "string" ? obj.what : "",
    when: typeof obj.when === "string" ? obj.when : "",
    where: typeof obj.where === "string" ? obj.where : "",
    who: typeof obj.who === "string" ? obj.who : "",
    why: typeof obj.why === "string" ? obj.why : "",
    fact_type: typeof obj.fact_type === "string" && (FACT_TYPES as string[]).includes(obj.fact_type)
      ? (obj.fact_type as FactType)
      : "world"
  };
  if (typeof obj.occurred_start === "string") out.occurred_start = obj.occurred_start;
  if (typeof obj.occurred_end === "string") out.occurred_end = obj.occurred_end;
  if (typeof obj.mentioned_at === "string") out.mentioned_at = obj.mentioned_at;
  if (Array.isArray(obj.entities)) {
    out.entities = obj.entities
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry, ei) => {
        const text = typeof entry.text === "string" ? entry.text : "";
        if (!text) throw new Error(`Fact ${index} entity ${ei} missing text`);
        const type = typeof entry.entity_type === "string" && (ENTITY_TYPES as string[]).includes(entry.entity_type)
          ? (entry.entity_type as EntityType)
          : undefined;
        return type ? { text, entity_type: type } : { text };
      });
  }
  if (Array.isArray(obj.causal_relations)) {
    // Drop entries whose relation_type is outside the causal enum instead of
    // failing the whole extraction. Models occasionally invent values like
    // "related" or "describes"; rejecting those used to throw and lose every
    // fact in the response.
    out.causal_relations = obj.causal_relations
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry, ci) => {
        const target_fact_index = asNumber(entry.target_fact_index, `fact ${index} causal_relations[${ci}].target_fact_index`);
        const relationRaw = typeof entry.relation_type === "string" ? entry.relation_type : "";
        if (!(CAUSAL_TYPES as readonly string[]).includes(relationRaw)) return null;
        const strength = typeof entry.strength === "number" ? Math.max(0, Math.min(1, entry.strength)) : 0.7;
        return { target_fact_index, relation_type: relationRaw as typeof CAUSAL_TYPES[number], strength };
      })
      .filter((entry): entry is { target_fact_index: number; relation_type: typeof CAUSAL_TYPES[number]; strength: number } => entry !== null);
  }
  return out;
}

export const opinionExtractionValidator: StructuredValidator<OpinionExtractionResponse> = {
  parse(value: unknown): OpinionExtractionResponse {
    const root = asObject(value);
    const raw = root.opinions;
    if (raw === undefined) return { opinions: [] };
    const opinions = asArray(raw).map((entry, index): ExtractedOpinion => {
      const obj = asObject(entry);
      return {
        opinion: asString(obj.opinion, `opinions[${index}].opinion`),
        confidence: typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0.5,
        reasoning: typeof obj.reasoning === "string" ? obj.reasoning : ""
      };
    });
    return { opinions };
  }
};

export const observationExtractionValidator: StructuredValidator<ObservationExtractionResponse> = {
  parse(value: unknown): ObservationExtractionResponse {
    const root = asObject(value);
    const raw = root.observations;
    if (raw === undefined) return { observations: [] };
    const observations = asArray(raw).map((entry, index) => {
      if (typeof entry === "string") return { observation: entry };
      const obj = asObject(entry);
      return { observation: asString(obj.observation, `observations[${index}].observation`) };
    });
    return { observations };
  }
};

export const opinionAssessmentValidator: StructuredValidator<OpinionAssessment> = {
  parse(value: unknown): OpinionAssessment {
    const obj = asObject(value);
    const verdict = asEnum(obj.verdict, ASSESSMENT_VERDICTS, "verdict");
    return {
      verdict,
      reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined
    };
  }
};
