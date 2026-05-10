// Hindsight phase 3 — recall pipeline.
//
// Four parallel retrieval channels, fused with reciprocal rank fusion (RRF).
// Token budget caps the final pack size (Eq. 17).
//
//   semantic — cosine similarity vs query embedding (Eqs. 9-10)
//   bm25     — SQLite FTS5 MATCH against memory_units_fts (Eq. 11)
//   graph    — spreading activation seeded from the top semantic hits;
//              decay δ=0.5; multipliers per channel (Eq. 12)
//   temporal — query parsed for an absolute / relative range; units whose
//              [occurred_start, occurred_end] interval overlaps the query
//              range (Eqs. 13-14). Channel returns empty if the query has
//              no temporal expression.
//
// Cross-encoder reranking runs on the top-N RRF candidates before the
// token-budget filter (Eq. 16). The reranker provider abstraction lives in
// src/reranker.ts; default is a local Transformers.js cross-encoder
// (Xenova/ms-marco-MiniLM-L-6-v2). Tail entries past the top-N keep their
// RRF order — cross-encoder cost grows with candidates and tail items
// rarely survive the token-budget pack anyway.
//
// Adapted from vectorize-io/hindsight (MIT). Channel-multiplier values and
// the RRF k=60 default match the upstream reference implementation.

import type { RuntimeConfig } from "../types";
import type {
  HindsightMemoryLink as MemoryLink,
  HindsightMemoryUnit as MemoryUnit,
  Network
} from "../state";
import {
  DEFAULT_BANK_ID,
  appendTrace,
  deserializeEmbedding,
  ensureDefaultBank,
  getMemoryDb,
  linksFromMany,
  updateMemoryUnitStats
} from "../state";
import { cosineSimilarity, getEmbeddingProvider } from "../embeddings";
import { getReranker, resolveRerankerChoice } from "../reranker";
import { parseTemporal, type TemporalRange } from "./temporal";

export const RRF_K = 60;
export const SEMANTIC_TOP_K = 50;
export const BM25_TOP_K = 50;
export const GRAPH_TOP_K = 50;
export const GRAPH_SEED_K = 10;
export const GRAPH_DECAY = 0.5; // δ
export const GRAPH_HOPS = 2;
export const GRAPH_MIN_ACTIVATION = 0.05;
export const DEFAULT_TOKEN_BUDGET = 2000;

export const CHANNEL_MULTIPLIERS: Record<MemoryLink["linkType"], number> = {
  causal: 1.5,
  entity: 1.3,
  semantic: 1.0,
  temporal: 0.8
};

export type RecallChannel = "semantic" | "bm25" | "graph" | "temporal";

export interface RecallInput {
  bankId?: string;
  query: string;
  tokenBudget?: number;
  network?: Network[];
  // Optional reference time for the temporal channel; defaults to now().
  reference?: string;
  sourceTaskId?: string;
}

export interface RecallScoredUnit {
  unit: MemoryUnit;
  score: number;
  channels: RecallChannel[];
  // Per-channel sub-scores (raw similarity / activation / etc.) — useful for
  // debugging and for the web UI's "why was this surfaced" tooltip.
  subscores: Partial<Record<RecallChannel, number>>;
}

export interface RecallOutput {
  units: RecallScoredUnit[];
  totalTokens: number;
  usage: Record<string, unknown>;
}

export async function recall(config: RuntimeConfig, input: RecallInput): Promise<RecallOutput> {
  const instance = config.instance;
  ensureDefaultBank(instance);
  const bankId = input.bankId ?? DEFAULT_BANK_ID;
  const tokenBudget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

  // 1. Embed the query (we'll need it for semantic + graph seeds).
  const embedProvider = getEmbeddingProvider(config);
  const [queryVector] = await embedProvider.embed([input.query]);

  // 2. Run channels in parallel where they're independent. Semantic channel
  // is scoped to the active provider's model — vectors from other models
  // live in a different space, so a cross-model cosine is meaningless.
  const [semanticHits, bm25Hits, temporalHits] = await Promise.all([
    runSemanticChannel(instance, bankId, queryVector ?? null, embedProvider.model, input.network),
    Promise.resolve(runBm25Channel(instance, bankId, input.query, input.network)),
    Promise.resolve(runTemporalChannel(instance, bankId, input.query, input.reference, input.network))
  ]);
  const graphHits = runGraphChannel(instance, semanticHits.slice(0, GRAPH_SEED_K).map((entry) => entry.unit.id));

  // 3. RRF fuse.
  const fused = fuseRrf({
    semantic: semanticHits.slice(0, SEMANTIC_TOP_K),
    bm25: bm25Hits.slice(0, BM25_TOP_K),
    graph: graphHits.slice(0, GRAPH_TOP_K),
    temporal: temporalHits
  });

  // 4. Cross-encoder rerank — only the top-N. The tail keeps RRF order so
  // a small cross-encoder isn't asked to score 100s of candidates that
  // would never survive the token-budget pack anyway. Skipped when the
  // active provider is `none`. If reranking throws (e.g. local model fails
  // mid-call), fall through to RRF order — recall must always return.
  const ordered = await applyReranker(config, input.query, fused);

  // 5. Pack to token budget.
  const packed: RecallScoredUnit[] = [];
  let totalTokens = 0;
  for (const candidate of ordered) {
    const cost = approxTokens(candidate.unit.text);
    if (totalTokens + cost > tokenBudget) continue;
    packed.push(candidate);
    totalTokens += cost;
  }

  // 6. Bump usage counters for the units we actually surfaced.
  const surfaceTime = new Date().toISOString();
  for (const entry of packed) {
    updateMemoryUnitStats(instance, entry.unit.id, { lastUsedAt: surfaceTime, bumpUsageCount: true });
  }

  if (input.sourceTaskId) {
    appendTrace(instance, input.sourceTaskId, {
      type: "memory",
      message: "recall completed",
      data: {
        query: input.query,
        units: packed.length,
        tokens: totalTokens,
        channels: countChannels(packed)
      }
    });
  }

  return {
    units: packed,
    totalTokens,
    usage: { input_tokens: input.query.length }
  };
}

// --------------------------------------------------------------------------
// Channels
// --------------------------------------------------------------------------

interface ChannelHit {
  unit: MemoryUnit;
  score: number;
}

async function runSemanticChannel(
  instance: string,
  bankId: string,
  queryVector: Float32Array | null,
  queryModel: string,
  networks: Network[] | undefined
): Promise<ChannelHit[]> {
  if (!queryVector) return [];
  const db = getMemoryDb(instance);
  const networkClause = networks && networks.length > 0
    ? `AND network IN (${networks.map(() => "?").join(",")})`
    : "";
  // Filter by embedding_model: cross-model cosine is meaningless. Units
  // embedded with a different model become invisible to semantic recall
  // until a `gini embedding reembed` walks them with the new provider.
  const rows = db
    .query<RawUnitRow, (string | number)[]>(
      `SELECT * FROM memory_units WHERE bank_id = ? AND status = 'active'
              AND embedding IS NOT NULL AND embedding_dim = ?
              AND embedding_model = ? ${networkClause}`
    )
    .all(bankId, queryVector.length, queryModel, ...(networks ?? []));
  const hits: ChannelHit[] = [];
  for (const row of rows) {
    const vector = deserializeEmbedding(row.embedding, row.embedding_dim);
    if (!vector) continue;
    const score = cosineSimilarity(queryVector, vector);
    if (score <= 0) continue;
    hits.push({ unit: rowToUnit(row), score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

function runBm25Channel(
  instance: string,
  bankId: string,
  query: string,
  networks: Network[] | undefined
): ChannelHit[] {
  if (!query.trim()) return [];
  const db = getMemoryDb(instance);
  const networkClause = networks && networks.length > 0
    ? `AND mu.network IN (${networks.map(() => "?").join(",")})`
    : "";
  // FTS5 MATCH wants escaping. Cheapest path: strip non-alphanumerics and
  // OR-join the remaining terms — produces a fast lexical match.
  const safe = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(" OR ");
  if (!safe) return [];
  try {
    const rows = db
      .query<RawUnitRow & { rank: number }, (string | number)[]>(
        `SELECT mu.*, bm25(memory_units_fts) AS rank
         FROM memory_units_fts
         JOIN memory_units mu ON mu.rowid = memory_units_fts.rowid
         WHERE memory_units_fts MATCH ? AND mu.bank_id = ? AND mu.status = 'active' ${networkClause}
         ORDER BY rank
         LIMIT 100`
      )
      .all(safe, bankId, ...(networks ?? []));
    return rows.map((row) => ({
      unit: rowToUnit(row),
      // FTS5 bm25() returns negative scores (lower = better); flip to positive
      // for monotonic ordering with the other channels.
      score: -row.rank
    }));
  } catch {
    return [];
  }
}

interface RawUnitRow {
  id: string;
  bank_id: string;
  text: string;
  embedding: Uint8Array | null;
  embedding_dim: number | null;
  embedding_model: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  mentioned_at: string;
  network: Network;
  confidence: number | null;
  metadata: string;
  source_task_id: string | null;
  source_session_id: string | null;
  status: MemoryUnit["status"];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  usage_count: number;
}

function rowToUnit(row: RawUnitRow): MemoryUnit {
  let metadata: Record<string, unknown> = {};
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch {}
  }
  return {
    id: row.id,
    bankId: row.bank_id,
    text: row.text,
    embedding: deserializeEmbedding(row.embedding, row.embedding_dim),
    embeddingDim: row.embedding_dim,
    embeddingModel: row.embedding_model,
    occurredStart: row.occurred_start,
    occurredEnd: row.occurred_end,
    mentionedAt: row.mentioned_at,
    network: row.network,
    confidence: row.confidence,
    metadata,
    sourceTaskId: row.source_task_id,
    sourceSessionId: row.source_session_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    usageCount: row.usage_count
  };
}

// Spreading-activation graph channel (Eq. 12). Seed with semantic top-K. BFS
// out to GRAPH_HOPS hops, decaying activation by δ * channel-multiplier per
// hop. Stops at units below GRAPH_MIN_ACTIVATION. Returns one entry per
// visited non-seed unit.
function runGraphChannel(instance: string, seedIds: string[]): ChannelHit[] {
  if (seedIds.length === 0) return [];
  const db = getMemoryDb(instance);
  // activation map: unitId -> max activation observed so far.
  const activation = new Map<string, number>();
  for (const seedId of seedIds) activation.set(seedId, 1.0);

  let frontier = new Set(seedIds);
  for (let hop = 0; hop < GRAPH_HOPS; hop++) {
    if (frontier.size === 0) break;
    const links = linksFromMany(instance, [...frontier]);
    const nextFrontier = new Set<string>();
    for (const link of links) {
      const sourceActivation = activation.get(link.fromUnit) ?? 0;
      if (sourceActivation < GRAPH_MIN_ACTIVATION) continue;
      const multiplier = CHANNEL_MULTIPLIERS[link.linkType] ?? 1.0;
      const propagated = sourceActivation * GRAPH_DECAY * multiplier * link.weight;
      if (propagated < GRAPH_MIN_ACTIVATION) continue;
      const existing = activation.get(link.toUnit) ?? 0;
      if (propagated > existing) {
        activation.set(link.toUnit, propagated);
        nextFrontier.add(link.toUnit);
      }
    }
    frontier = nextFrontier;
  }

  // Strip seeds; we only want indirectly-reached units in this channel.
  for (const seedId of seedIds) activation.delete(seedId);
  if (activation.size === 0) return [];

  const ids = [...activation.keys()];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query<RawUnitRow, string[]>(
      `SELECT * FROM memory_units WHERE id IN (${placeholders}) AND status = 'active'`
    )
    .all(...ids);
  const hits: ChannelHit[] = rows.map((row) => ({
    unit: rowToUnit(row),
    score: activation.get(row.id) ?? 0
  }));
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

function runTemporalChannel(
  instance: string,
  bankId: string,
  query: string,
  reference: string | undefined,
  networks: Network[] | undefined
): ChannelHit[] {
  const refDate = reference ? new Date(reference) : new Date();
  const range = extractTemporalRange(query, refDate);
  if (!range) return [];
  const db = getMemoryDb(instance);
  const networkClause = networks && networks.length > 0
    ? `AND network IN (${networks.map(() => "?").join(",")})`
    : "";
  // Overlap predicate: occurred_start <= range.end AND occurred_end >= range.start.
  const rows = db
    .query<RawUnitRow, (string | number)[]>(
      `SELECT * FROM memory_units
       WHERE bank_id = ? AND status = 'active'
         AND occurred_start IS NOT NULL AND occurred_end IS NOT NULL
         AND occurred_start <= ? AND occurred_end >= ?
         ${networkClause}
       ORDER BY occurred_start DESC
       LIMIT 100`
    )
    .all(bankId, range.end, range.start, ...(networks ?? []));

  const queryMid = (Date.parse(range.start) + Date.parse(range.end)) / 2;
  const queryHalfWidth = Math.max(1, (Date.parse(range.end) - Date.parse(range.start)) / 2);

  return rows.map((row) => {
    const start = Date.parse(row.occurred_start ?? "");
    const end = Date.parse(row.occurred_end ?? "");
    const unitMid = (start + end) / 2;
    const distance = Math.abs(queryMid - unitMid);
    // Closer to the query midpoint = higher score. Score in [0,1].
    const score = 1 / (1 + distance / queryHalfWidth);
    return { unit: rowToUnit(row), score };
  });
}

// Try to pull the temporal expression out of an arbitrary query. We try the
// whole query first; if that fails we fall through to a small set of common
// suffixes / phrases to give the parser a fair shot at "what did I do
// yesterday" style questions.
function extractTemporalRange(query: string, reference: Date): TemporalRange | null {
  const direct = parseTemporal(query, reference);
  if (direct) return direct;
  // Pick out the first temporal-shaped substring.
  const candidates = [
    /(today|yesterday|tomorrow)/i,
    /(this|last|next)\s+(week|month|year)/i,
    /\d{4}-\d{2}-\d{2}/,
    /\d+\s+(day|days|week|weeks|month|months|year|years)\s+ago/i,
    /in\s+\d+\s+(day|days|week|weeks|month|months|year|years)/i,
    /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)?,?\s*[A-Za-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/i
  ];
  for (const pattern of candidates) {
    const match = pattern.exec(query);
    if (!match) continue;
    const range = parseTemporal(match[0], reference);
    if (range) return range;
  }
  return null;
}

// --------------------------------------------------------------------------
// RRF fusion (Eq. 15)
// --------------------------------------------------------------------------

interface ChannelInput {
  semantic: ChannelHit[];
  bm25: ChannelHit[];
  graph: ChannelHit[];
  temporal: ChannelHit[];
}

function fuseRrf(channels: ChannelInput): RecallScoredUnit[] {
  const scoreMap = new Map<string, RecallScoredUnit>();
  const channelEntries: Array<[RecallChannel, ChannelHit[]]> = [
    ["semantic", channels.semantic],
    ["bm25", channels.bm25],
    ["graph", channels.graph],
    ["temporal", channels.temporal]
  ];
  for (const [name, hits] of channelEntries) {
    hits.forEach((hit, rank) => {
      const rrfBoost = 1 / (RRF_K + rank + 1);
      const existing = scoreMap.get(hit.unit.id);
      if (existing) {
        existing.score += rrfBoost;
        if (!existing.channels.includes(name)) existing.channels.push(name);
        existing.subscores[name] = hit.score;
      } else {
        scoreMap.set(hit.unit.id, {
          unit: hit.unit,
          score: rrfBoost,
          channels: [name],
          subscores: { [name]: hit.score }
        });
      }
    });
  }
  const fused = [...scoreMap.values()];
  fused.sort((a, b) => b.score - a.score);
  return fused;
}

// --------------------------------------------------------------------------
// Cross-encoder reranking (Eq. 16)
// --------------------------------------------------------------------------

async function applyReranker(
  config: RuntimeConfig,
  query: string,
  fused: RecallScoredUnit[]
): Promise<RecallScoredUnit[]> {
  if (fused.length === 0) return fused;
  const choice = resolveRerankerChoice(config);
  if (choice.name === "none") return fused;
  const head = fused.slice(0, choice.topN);
  const tail = fused.slice(choice.topN);
  const reranker = getReranker(config);
  let scores: number[];
  try {
    scores = await reranker.score(query, head.map((entry) => entry.unit.text));
  } catch {
    // Reranker blew up mid-call; recall must always return. Pass through
    // the existing RRF ordering so callers see a degraded-but-valid result.
    return fused;
  }
  if (scores.length !== head.length) return fused;
  const reranked = head
    .map((entry, i) => ({ ...entry, score: scores[i] ?? entry.score }))
    .sort((a, b) => b.score - a.score);
  return [...reranked, ...tail];
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function approxTokens(text: string): number {
  // chars/4 is the de facto rough English estimate. Plenty for budget pacing.
  return Math.ceil(text.length / 4);
}

function countChannels(units: RecallScoredUnit[]): Record<RecallChannel, number> {
  const out: Record<RecallChannel, number> = { semantic: 0, bm25: 0, graph: 0, temporal: 0 };
  for (const unit of units) for (const channel of unit.channels) out[channel] += 1;
  return out;
}
