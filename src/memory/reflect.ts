// Hindsight phase 4 — reflect pipeline (paper §5).
//
// Behavioral profile-conditioned response generation + opinion formation:
//
//   1. Recall: pull the most relevant facts from the bank for the query
//      (re-uses phase 3's recall pipeline).
//   2. Compose a system message: bank name + background + verbalized profile
//      conditioned by the bank's bias_strength (Eq. 23).
//   3. Generate a response via the configured provider.
//   4. Extract opinions from the response (Appendix A.2 prompt) and store
//      them as MemoryUnit rows with network='opinion' and metadata.reasoning.
//
// Bank profile CRUD lives in src/state/memory-db.ts (getBank / updateBank).
//
// Adapted from vectorize-io/hindsight (MIT). The verbalization wording mirrors
// the upstream phrase bands exactly so behaviour matches the paper's reported
// distribution.

import type { RuntimeConfig } from "../types";
import type {
  HindsightMemoryUnit as MemoryUnit,
  MemoryBank
} from "../state";
import {
  DEFAULT_BANK_ID,
  addAudit,
  appendTrace,
  bankIdForAgent,
  ensureAgentBank,
  ensureDefaultBank,
  getBank,
  insertMemoryUnit,
  mutateState
} from "../state";
import { generateStructured, generateTaskSummary } from "../provider";
import { getEmbeddingProvider } from "../embeddings";
import { providerOverrideForRuntime } from "../execution/effective-context";
import { recall } from "./recall";
import { opinionExtractionValidator, type ExtractedOpinion } from "./schemas";

export interface ReflectInput {
  agentId: string;
  bankId?: string;
  query: string;
  tokenBudget?: number;
  sourceTaskId?: string;
}

export interface ReflectOutput {
  response: string;
  opinions: MemoryUnit[];
  recalled: number;
  usage: Record<string, unknown>;
}

export async function reflect(config: RuntimeConfig, input: ReflectInput): Promise<ReflectOutput> {
  const instance = config.instance;
  if (!input.agentId) throw new Error("reflect: agentId is required (Phase C per-agent memory isolation)");
  ensureDefaultBank(instance);
  ensureAgentBank(instance, input.agentId);
  const bankId = input.bankId ?? bankIdForAgent(input.agentId);
  const bank = getBank(instance, bankId);
  if (!bank) throw new Error(`Bank not found: ${bankId}`);

  // Resolve the active agent's provider override once. Used for the LLM
  // generation and opinion-extraction calls below. Embeddings/reranker
  // stay on config.provider (semantic-recall stability — see ADR 0006).
  const providerOverride = providerOverrideForRuntime(config);

  // 1. Recall.
  const recalled = await recall(config, {
    agentId: input.agentId,
    bankId,
    query: input.query,
    tokenBudget: input.tokenBudget ?? 2000,
    sourceTaskId: input.sourceTaskId
  });

  // 2. Build the system message.
  const systemMessage = buildReflectSystemMessage(bank, recalled.units.map((entry) => entry.unit));

  // 3. Generate. We piggyback on generateTaskSummary's provider routing by
  // building a single composite prompt for the user turn. For non-echo this
  // routes to the OpenAI Responses API (or the chat-completions fallback for
  // local/openrouter).
  const userPrompt = `${systemMessage}\n\nQuestion: ${input.query}\n\nProvide your response.`;
  const generated = await generateTaskSummary(config, userPrompt, [], undefined, undefined, providerOverride);

  // 4. Extract opinions.
  const opinionStub = await generateStructured(config, {
    system: OPINION_FORMATION_SYSTEM,
    user: OPINION_FORMATION_USER_TEMPLATE(input.query, generated.text),
    schemaName: "OpinionExtractionResponse",
    validator: opinionExtractionValidator,
    echoTag: "opinion-formation"
  }, providerOverride);
  const extracted = opinionStub.data.opinions ?? [];
  const insertedOpinions = await persistOpinions(config, bankId, input.agentId, extracted, input.sourceTaskId);

  // 5. Audit + trace.
  await mutateState(instance, (state) => {
    addAudit(state, {
      actor: "runtime",
      action: "memory.reflect",
      target: bankId,
      risk: "low",
      taskId: input.sourceTaskId,
      evidence: { query: input.query, opinions: insertedOpinions.length, recalled: recalled.units.length }
    });
  });
  if (input.sourceTaskId) {
    appendTrace(instance, input.sourceTaskId, {
      type: "memory",
      message: "reflect completed",
      data: { opinions: insertedOpinions.length, recalled: recalled.units.length }
    });
  }

  return {
    response: generated.text,
    opinions: insertedOpinions,
    recalled: recalled.units.length,
    usage: generated.usage ?? {}
  };
}

async function persistOpinions(
  config: RuntimeConfig,
  bankId: string,
  agentId: string,
  extracted: ExtractedOpinion[],
  sourceTaskId: string | undefined
): Promise<MemoryUnit[]> {
  if (extracted.length === 0) return [];
  const provider = getEmbeddingProvider(config);
  const vectors = await provider.embed(extracted.map((entry) => entry.opinion));
  const inserted: MemoryUnit[] = [];
  for (let i = 0; i < extracted.length; i++) {
    const opinion = extracted[i]!;
    const unit = insertMemoryUnit(config.instance, {
      bankId,
      agentId,
      text: opinion.opinion,
      embedding: vectors[i] ?? null,
      embeddingModel: provider.model,
      network: "opinion",
      confidence: opinion.confidence,
      metadata: { reasoning: opinion.reasoning },
      sourceTaskId: sourceTaskId ?? null
    });
    inserted.push(unit);
  }
  return inserted;
}

// --------------------------------------------------------------------------
// Verbalization (Eq. 23 + paper §5.2.1)
// --------------------------------------------------------------------------

const SKEPTICISM_BANDS: Record<number, string> = {
  1: "trusting and accepting of statements at face value",
  2: "open and inclined to trust",
  3: "balanced in your trust of statements",
  4: "cautious and inclined to verify",
  5: "skeptical and probing of claims"
};

const LITERALISM_BANDS: Record<number, string> = {
  1: "very flexibly, embracing metaphor and figurative meaning",
  2: "flexibly, often reading between the lines",
  3: "in a balanced way",
  4: "literally, taking words at their plain meaning",
  5: "highly literally, treating language as precise"
};

const EMPATHY_BANDS: Record<number, string> = {
  1: "detached and analytical",
  2: "neutral and matter-of-fact",
  3: "considerate of others' perspectives",
  4: "warm and emotionally attentive",
  5: "highly empathetic and emotionally engaged"
};

export function verbalizeProfile(bank: MemoryBank): string {
  const skep = SKEPTICISM_BANDS[clamp(bank.skepticism, 1, 5)] ?? SKEPTICISM_BANDS[3]!;
  const lit = LITERALISM_BANDS[clamp(bank.literalism, 1, 5)] ?? LITERALISM_BANDS[3]!;
  const emp = EMPATHY_BANDS[clamp(bank.empathy, 1, 5)] ?? EMPATHY_BANDS[3]!;
  return `You are ${skep}, you interpret language ${lit}, and you are ${emp}.`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function buildReflectSystemMessage(bank: MemoryBank, units: MemoryUnit[]): string {
  const sections: string[] = [];
  sections.push(`You are ${bank.agentName ?? bank.name}.`);
  if (bank.background) sections.push(bank.background);

  // Bias strength modulates the prompt presence (paper §5.4.2).
  const bias = Math.max(0, Math.min(1, bank.biasStrength));
  if (bias <= 0.05) {
    // De-emphasize style — drop the verbalized profile entirely.
    sections.push("Respond in a neutral, factual style.");
  } else if (bias < 0.5) {
    sections.push(`Personality (apply lightly): ${verbalizeProfile(bank)}`);
  } else if (bias < 0.9) {
    sections.push(`Personality: ${verbalizeProfile(bank)}`);
  } else {
    sections.push(`Personality (very strong): ${verbalizeProfile(bank)} Let this strongly shape your tone.`);
  }

  if (units.length > 0) {
    const block = units
      .map((unit, idx) => `${idx + 1}. (${unit.network}${unit.confidence !== null ? `, conf=${unit.confidence.toFixed(2)}` : ""}) ${unit.text}`)
      .join("\n");
    sections.push(`Relevant memories:\n${block}`);
  } else {
    sections.push("No directly relevant memories on file.");
  }
  return sections.join("\n\n");
}

// --------------------------------------------------------------------------
// Prompts (Appendix A.2)
// --------------------------------------------------------------------------

const OPINION_FORMATION_SYSTEM = `Extract any NEW opinions or perspectives from the answer below and rewrite them in FIRST-PERSON as if YOU are stating the opinion directly. An opinion is a judgment, viewpoint, or conclusion that goes beyond just stating facts. Skip statements that mean "I don't know" or "the facts don't say". Output JSON: { "opinions": [{ "opinion": "I think...", "confidence": 0.0-1.0, "reasoning": "..." }] }.`;

const OPINION_FORMATION_USER_TEMPLATE = (query: string, answer: string) =>
  `ORIGINAL QUESTION:\n${query}\n\nANSWER PROVIDED:\n${answer}\n\nExtract first-person opinions only — no facts, no abstentions, no third-person attributions. Provide a confidence score (0.0-1.0).`;
