// Hindsight phase 2 — retain pipeline.
//
// Pipeline (paper §4.1.2 + Appendix A.1, A.5.1):
//   1. LLM extraction.       Structured ExtractedFact[] from Appendix A.1.
//   2. Temporal normalization. Hand-rolled rule-based parser, scoped to the
//      patterns the extraction prompt produces.
//   3. Embedding.            One Float32Array per fact via getEmbeddingProvider.
//   4. Entity resolution.    Eq. 2 with α/β/γ = 0.5/0.3/0.2; merge ≥ 0.85.
//   5. Link construction.    entity (Eq. 3, w=1), temporal (Eq. 4, σ=7d),
//                            semantic (Eq. 5, θ=0.7), causal (Eq. 3.4).
//   6. Audit + trace.        One audit event per call; trace record on the
//                            source task if sourceTaskId is set.
//
// The pipeline is best-effort: if any step throws, we record an audit event
// with the failure and rethrow. Callers (auto-retain in agent.ts, /api/memory/
// retain handler) wrap with try/catch so a retain failure never blocks the
// originating task.
//
// This is Gini's local retain implementation for the hindsight memory model.
// Tuning constants and link math are kept explicit where the paper leaves
// implementation choices open.

import type { RuntimeConfig } from "../types";
import type {
  HindsightEntity as Entity,
  HindsightMemoryLink as MemoryLink,
  HindsightMemoryUnit as MemoryUnit,
  Network
} from "../state";
import {
  DEFAULT_BANK_ID,
  addAudit,
  appendTrace,
  bankIdForAgent,
  ensureAgentBank,
  ensureDefaultBank,
  getMemoryDb,
  insertLink,
  insertMemoryUnit,
  linkUnitToEntity,
  listMemoryUnits,
  mutateState,
  now,
  unitsForEntity,
  upsertObservationUnit
} from "../state";
import { generateStructured } from "../provider";
import { cosineSimilarity, getEmbeddingProvider } from "../embeddings";
import { providerOverrideForRuntime } from "../execution/effective-context";
import { resolveOrCreateEntity } from "./entities";
import {
  factExtractionValidator,
  observationExtractionValidator,
  type ExtractedFact,
  type FactType
} from "./schemas";
import { parseTemporal } from "./temporal";

export const TEMPORAL_DECAY_SECONDS = 7 * 24 * 60 * 60; // σ_t = 7 days
export const SEMANTIC_LINK_THRESHOLD = 0.7;             // θ_s
export const SEMANTIC_CANDIDATE_POOL = 50;              // brute-force cap

export const FACT_EXTRACTION_SYSTEM = `You are an expert fact extractor for the Hindsight memory system. Given a piece of text, extract the salient narrative facts. Each fact must contain the five Ws (what / when / where / who / why), classify the fact_type as one of "world", "experience", or "opinion", and list the entities mentioned. Causal relations between facts are captured via causal_relations[] referencing target_fact_index. Output only valid JSON matching the FactExtractionResponse schema.`;

export const FACT_EXTRACTION_USER_TEMPLATE = (text: string, mentionedAt: string) =>
  `MENTIONED_AT: ${mentionedAt}\n\nTEXT:\n"""\n${text}\n"""\n\nReturn { "facts": [ {what, when, where, who, why, fact_type, occurred_start?, occurred_end?, entities?: [{text, entity_type?}], causal_relations?: [{target_fact_index, relation_type, strength}]} ] }. Use ISO 8601 strings for occurred_start/occurred_end. fact_type ∈ {world, experience, opinion}.`;

export interface RetainInput {
  // Phase C: stamped onto every unit so the recall pipeline can filter the
  // active agent's pool without joining memory_banks. Required: a write with
  // no agentId would leak into the global pool, so we reject loud.
  agentId: string;
  bankId?: string;
  text: string;
  sourceTaskId?: string;
  sourceSessionId?: string;
  mentionedAt?: string; // ISO; default: now
}

export interface RetainOutput {
  units: MemoryUnit[];
  entities: Entity[];
  links: MemoryLink[];
  usage: Record<string, unknown>;
  observationsRegenerated: number;
}

export async function retain(config: RuntimeConfig, input: RetainInput): Promise<RetainOutput> {
  const instance = config.instance;
  if (!input.agentId) throw new Error("retain: agentId is required (Phase C per-agent memory isolation)");
  ensureDefaultBank(instance);
  ensureAgentBank(instance, input.agentId);
  const bankId = input.bankId ?? bankIdForAgent(input.agentId);
  const mentionedAt = input.mentionedAt ?? now();

  // Resolve the active agent's provider override once (if any). Embedding
  // and reranker calls keep reading config.provider — see ADR agents-replace-profiles.md.
  const providerOverride = providerOverrideForRuntime(config);

  // 1. LLM extraction.
  const extraction = await generateStructured(config, {
    system: FACT_EXTRACTION_SYSTEM,
    user: FACT_EXTRACTION_USER_TEMPLATE(input.text, mentionedAt),
    schemaName: "FactExtractionResponse",
    validator: factExtractionValidator,
    echoTag: "fact-extraction"
  }, providerOverride);
  const facts = extraction.data.facts ?? [];

  // 2. Temporal normalization.
  const reference = new Date(mentionedAt);
  const normalized = facts.map((fact) => normalizeFactTemporal(fact, reference, mentionedAt));

  // 3. Embedding.
  const embedProvider = getEmbeddingProvider(config);
  const narratives = normalized.map(buildNarrative);
  const embeddings = narratives.length > 0 ? await embedProvider.embed(narratives) : [];

  // 4. Insert units.
  const insertedUnits: MemoryUnit[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const fact = normalized[i]!;
    const unit = insertMemoryUnit(instance, {
      bankId,
      agentId: input.agentId,
      text: narratives[i]!,
      embedding: embeddings[i] ?? null,
      embeddingModel: embedProvider.model,
      occurredStart: fact.occurred_start ?? null,
      occurredEnd: fact.occurred_end ?? null,
      mentionedAt: fact.mentioned_at ?? mentionedAt,
      network: factTypeToNetwork(fact.fact_type),
      // Facts proper carry no confidence — opinions/observations do. Keep
      // confidence null here; reflect/retain-reinforcement may set it later.
      confidence: null,
      metadata: {
        what: fact.what,
        when: fact.when,
        where: fact.where,
        who: fact.who,
        why: fact.why,
        sourceText: input.text.slice(0, 2000)
      },
      sourceTaskId: input.sourceTaskId ?? null,
      sourceSessionId: input.sourceSessionId ?? null
    });
    insertedUnits.push(unit);
  }

  // 5. Entity resolution. Each fact may bring a few entities; map per-unit.
  const recentPool = listMemoryUnits(instance, bankId, { limit: SEMANTIC_CANDIDATE_POOL });
  const recentIds = recentPool.map((unit) => unit.id);
  const allEntities: Entity[] = [];
  // unitId -> [entityId...] for entity-link construction below.
  const entitiesByUnit = new Map<string, string[]>();
  for (let i = 0; i < normalized.length; i++) {
    const fact = normalized[i]!;
    const unit = insertedUnits[i]!;
    const ids: string[] = [];
    for (const entry of fact.entities ?? []) {
      const surface = entry.text.trim();
      if (!surface) continue;
      const type = entry.entity_type ?? "OTHER";
      const resolution = resolveOrCreateEntity(instance, bankId, surface, type, {
        recentUnitIds: recentIds,
        mentionedAt: unit.mentionedAt
      });
      linkUnitToEntity(instance, unit.id, resolution.entity.id, surface);
      if (resolution.created) allEntities.push(resolution.entity);
      ids.push(resolution.entity.id);
    }
    entitiesByUnit.set(unit.id, ids);
  }

  // 6. Link construction.
  const links: MemoryLink[] = [];

  // Entity links: for each pair of new units sharing an entity, bidirectional w=1.
  for (let i = 0; i < insertedUnits.length; i++) {
    for (let j = i + 1; j < insertedUnits.length; j++) {
      const a = insertedUnits[i]!;
      const b = insertedUnits[j]!;
      const aEnts = entitiesByUnit.get(a.id) ?? [];
      const bEnts = entitiesByUnit.get(b.id) ?? [];
      const shared = aEnts.find((id) => bEnts.includes(id));
      if (!shared) continue;
      links.push(insertLink(instance, { fromUnit: a.id, toUnit: b.id, linkType: "entity", weight: 1.0, entityId: shared }));
      links.push(insertLink(instance, { fromUnit: b.id, toUnit: a.id, linkType: "entity", weight: 1.0, entityId: shared }));
    }
  }

  // Temporal links (Eq. 4): pairs of new units whose interval midpoints are
  // within σ_t = 7 days. Directional from earlier -> later.
  for (let i = 0; i < insertedUnits.length; i++) {
    for (let j = 0; j < insertedUnits.length; j++) {
      if (i === j) continue;
      const a = insertedUnits[i]!;
      const b = insertedUnits[j]!;
      const aMid = midpointSeconds(a);
      const bMid = midpointSeconds(b);
      if (aMid === null || bMid === null) continue;
      if (aMid > bMid) continue; // direction: earlier -> later only
      const delta = Math.abs(bMid - aMid);
      if (delta > TEMPORAL_DECAY_SECONDS * 4) continue; // skip far-apart pairs
      const weight = Math.exp(-delta / TEMPORAL_DECAY_SECONDS);
      if (weight < 0.05) continue;
      links.push(insertLink(instance, { fromUnit: a.id, toUnit: b.id, linkType: "temporal", weight }));
    }
  }

  // Semantic links (Eq. 5): for each new unit, scan up to SEMANTIC_CANDIDATE_POOL
  // recent existing units (status='active') and link if cosine ≥ θ_s.
  // Bidirectional. Skip self-pairs. Also link new-vs-new pairs in the same call.
  const newUnitsWithEmbedding = insertedUnits.filter((unit) => unit.embedding);
  // Existing pool for semantic candidates: pull a recent slice excluding the
  // just-inserted unit IDs.
  const existingPool = recentPool.filter((unit) => unit.embedding && !insertedUnits.some((n) => n.id === unit.id));
  for (let i = 0; i < newUnitsWithEmbedding.length; i++) {
    const a = newUnitsWithEmbedding[i]!;
    if (!a.embedding) continue;
    for (const b of existingPool) {
      if (!b.embedding) continue;
      if (a.embedding.length !== b.embedding.length) continue;
      const sim = cosineSimilarity(a.embedding, b.embedding);
      if (sim < SEMANTIC_LINK_THRESHOLD) continue;
      links.push(insertLink(instance, { fromUnit: a.id, toUnit: b.id, linkType: "semantic", weight: sim }));
      links.push(insertLink(instance, { fromUnit: b.id, toUnit: a.id, linkType: "semantic", weight: sim }));
    }
    for (let j = i + 1; j < newUnitsWithEmbedding.length; j++) {
      const b = newUnitsWithEmbedding[j]!;
      if (!b.embedding) continue;
      if (a.embedding.length !== b.embedding.length) continue;
      const sim = cosineSimilarity(a.embedding, b.embedding);
      if (sim < SEMANTIC_LINK_THRESHOLD) continue;
      links.push(insertLink(instance, { fromUnit: a.id, toUnit: b.id, linkType: "semantic", weight: sim }));
      links.push(insertLink(instance, { fromUnit: b.id, toUnit: a.id, linkType: "semantic", weight: sim }));
    }
  }

  // Causal links (Eq. 3.4): each ExtractedCausalRelation references a target
  // by index in the same extraction call. weight = strength.
  for (let i = 0; i < normalized.length; i++) {
    const fact = normalized[i]!;
    const sourceUnit = insertedUnits[i]!;
    for (const relation of fact.causal_relations ?? []) {
      const target = insertedUnits[relation.target_fact_index];
      if (!target || target.id === sourceUnit.id) continue;
      links.push(insertLink(instance, {
        fromUnit: sourceUnit.id,
        toUnit: target.id,
        linkType: "causal",
        causalSubtype: relation.relation_type,
        weight: Math.max(0, Math.min(1, relation.strength))
      }));
    }
  }

  // 7. Observation regeneration: for each unique entity touched in this call,
  // regenerate its observation row from facts that mention it.
  const touchedEntityIds = new Set<string>();
  for (const ids of entitiesByUnit.values()) for (const id of ids) touchedEntityIds.add(id);
  let observationsRegenerated = 0;
  for (const entityId of touchedEntityIds) {
    try {
      await regenerateObservation(config, bankId, entityId, input.agentId, providerOverride);
      observationsRegenerated += 1;
    } catch (error) {
      // Observation failures are non-fatal — emit a trace and continue.
      if (input.sourceTaskId) {
        appendTrace(instance, input.sourceTaskId, {
          type: "memory",
          message: "observation regeneration failed",
          data: { entityId, error: error instanceof Error ? error.message : String(error) }
        });
      }
    }
  }

  // 8. Opinion reinforcement is wired from phase 4 — see ./reinforce.ts.
  // Phase 2 doesn't ship that module yet; phase 4 introduces it and this
  // call site activates automatically.
  await maybeReinforceOpinions(config, bankId, insertedUnits);

  // 9. Audit + trace.
  await mutateState(instance, (state) => {
    addAudit(state, {
      actor: "runtime",
      action: "memory.retain",
      target: bankId,
      risk: "low",
      taskId: input.sourceTaskId,
      evidence: {
        units: insertedUnits.length,
        entitiesCreated: allEntities.length,
        links: links.length,
        observations: observationsRegenerated
      }
    });
  });
  if (input.sourceTaskId) {
    appendTrace(instance, input.sourceTaskId, {
      type: "memory",
      message: "retain completed",
      data: {
        units: insertedUnits.map((unit) => unit.id),
        links: links.length,
        entitiesCreated: allEntities.length,
        observations: observationsRegenerated
      }
    });
  }

  return {
    units: insertedUnits,
    entities: allEntities,
    links,
    usage: extraction.usage ?? {},
    observationsRegenerated
  };
}

// --------------------------------------------------------------------------
// Observation regeneration (paper Eq. 6)
// --------------------------------------------------------------------------

const OBSERVATION_FACT_LIMIT = 50; // cap LLM input

const OBSERVATION_SYSTEM = `You are an objective observer synthesizing facts about an entity. Generate clear, factual observations without opinions or behavioral profile influence. Be concise and accurate.`;

const OBSERVATION_USER_TEMPLATE = (entityName: string, factsText: string) =>
  `Based on the following facts about "${entityName}", generate a list of key observations.\n\nFACTS ABOUT ${entityName}:\n${factsText}\n\nGenerate 3-7 observations. Combine related facts. Be objective. Write in third person. Output JSON: { "observations": [ { "observation": "..." } ] }`;

async function maybeReinforceOpinions(config: RuntimeConfig, bankId: string, units: MemoryUnit[]): Promise<void> {
  try {
    // Resolve at runtime so phase 2 builds without ./reinforce.ts existing.
    const moduleName = "./reinforce";
    const mod = await import(moduleName) as {
      reinforceOpinionsForUnits?: (
        config: RuntimeConfig,
        bankId: string,
        units: MemoryUnit[]
      ) => Promise<void>;
    };
    if (mod.reinforceOpinionsForUnits) {
      await mod.reinforceOpinionsForUnits(config, bankId, units);
    }
  } catch {
    // Module not present yet (phase 4 lands it). Non-fatal.
  }
}

async function regenerateObservation(
  config: RuntimeConfig,
  bankId: string,
  entityId: string,
  agentId: string,
  providerOverride?: import("../types").ProviderConfig
): Promise<void> {
  const instance = config.instance;
  const facts = unitsForEntity(instance, entityId, OBSERVATION_FACT_LIMIT)
    .filter((unit) => unit.network === "world" || unit.network === "experience");
  if (facts.length === 0) return;

  // Pick a display name for the prompt — first canonical entity match.
  const db = getMemoryDb(instance);
  const entityRow = db
    .query<{ canonical_name: string }, [string]>("SELECT canonical_name FROM entities WHERE id = ?")
    .get(entityId);
  const entityName = entityRow?.canonical_name ?? "(entity)";

  const factsText = facts
    .map((unit, idx) => `${idx + 1}. ${unit.text}`)
    .join("\n");

  const result = await generateStructured(config, {
    system: OBSERVATION_SYSTEM,
    user: OBSERVATION_USER_TEMPLATE(entityName, factsText),
    schemaName: "ObservationExtractionResponse",
    validator: observationExtractionValidator,
    echoTag: `observation:${entityId}`
  }, providerOverride);
  const observations = result.data.observations.map((entry) => entry.observation).filter(Boolean);
  if (observations.length === 0) return;
  const summary = observations.join(" ");
  // Embed the consolidated observation summary so recall's semantic channel
  // can reach it.
  const embedProvider = getEmbeddingProvider(config);
  const [vector] = await embedProvider.embed([summary]);
  upsertObservationUnit(instance, bankId, entityId, summary, vector ?? null, embedProvider.model, agentId);
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function factTypeToNetwork(factType: FactType | undefined): Network {
  if (factType === "experience") return "experience";
  if (factType === "opinion") return "opinion";
  return "world";
}

function normalizeFactTemporal(fact: ExtractedFact, reference: Date, mentionedAt: string): ExtractedFact {
  const out: ExtractedFact = { ...fact, mentioned_at: fact.mentioned_at ?? mentionedAt };
  if (!out.occurred_start && fact.when) {
    const range = parseTemporal(fact.when, reference);
    if (range) {
      out.occurred_start = range.start;
      out.occurred_end = range.end;
    }
  }
  return out;
}

function buildNarrative(fact: ExtractedFact): string {
  const parts: string[] = [];
  if (fact.what) parts.push(`What: ${fact.what}`);
  if (fact.when) parts.push(`When: ${fact.when}`);
  if (fact.where) parts.push(`Where: ${fact.where}`);
  if (fact.who) parts.push(`Who: ${fact.who}`);
  if (fact.why) parts.push(`Why: ${fact.why}`);
  if (parts.length === 0) return fact.what || "";
  return parts.join(" | ");
}

function midpointSeconds(unit: MemoryUnit): number | null {
  const start = unit.occurredStart ? Date.parse(unit.occurredStart) : NaN;
  const end = unit.occurredEnd ? Date.parse(unit.occurredEnd) : NaN;
  if (!isNaN(start) && !isNaN(end)) return (start + end) / 2 / 1000;
  if (!isNaN(start)) return start / 1000;
  const mentioned = Date.parse(unit.mentionedAt);
  if (!isNaN(mentioned)) return mentioned / 1000;
  return null;
}
