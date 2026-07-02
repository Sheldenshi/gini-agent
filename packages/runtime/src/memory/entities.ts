// Hindsight phase 2 — entity resolution + canonical-store helpers.
//
// Paper Eq. 2 scores a candidate canonical entity using:
//   sim_total = α * lex(name) + β * cooc(units) + γ * temp(units)
// with α=0.5, β=0.3, γ=0.2 from the brief. Lexical similarity is normalized
// Levenshtein. Co-occurrence is computed across recent units (the unit set
// the new mention shares with each existing canonical). Temporal proximity
// is the average inverse-day distance of the newest mention vs the candidate
// canonical's most-recent mention. We keep the function lightweight so retain
// can call it once per extracted entity without an N^2 blowup.
//
// Gini's entity resolver keeps the paper's weighted-match shape while making
// the merge threshold and low-confidence fallback explicit for local tuning.

import type { Instance } from "../types";
import type { Database } from "bun:sqlite";
import type { HindsightEntity as Entity, EntityType } from "../state";
import { getMemoryDb, insertEntity } from "../state";

// Eq. 2 weighted score must exceed this to count as "same canonical entity".
// With α/β/γ summing to 1, the score is in [0,1]; the brief's 0.85 threshold
// applies to the full weighted score. We additionally short-circuit on
// near-perfect lexical matches (≥ LEXICAL_EXACT_FAST_PATH) so two mentions of
// the same surface always merge even when they share no co-occurrence /
// temporal signal yet — the typical "first call retains 'Bob', second call
// retains 'Bob' a day later" path. Upstream uses the same fast-path.
export const ENTITY_MERGE_THRESHOLD = 0.85;
export const LEXICAL_EXACT_FAST_PATH = 0.85;

export const ENTITY_RESOLUTION_WEIGHTS = {
  alpha: 0.5, // lexical
  beta: 0.3,  // co-occurrence
  gamma: 0.2  // temporal proximity
} as const;

interface CandidateEntity {
  id: string;
  bank_id: string;
  canonical_name: string;
  entity_type: EntityType;
  created_at: string;
}

export function resolveOrCreateEntity(
  instance: Instance,
  bankId: string,
  surface: string,
  type: EntityType,
  context?: { recentUnitIds?: string[]; mentionedAt?: string }
): { entity: Entity; created: boolean; score: number } {
  const db = getMemoryDb(instance);
  const candidates = db
    .query<CandidateEntity, [string]>("SELECT * FROM entities WHERE bank_id = ?")
    .all(bankId);

  let best: { row: CandidateEntity; score: number; lex: number } | null = null;
  for (const row of candidates) {
    const lex = lexicalSimilarity(row.canonical_name, surface);
    const score = scoreCandidate(db, row, surface, context, lex);
    if (!best || score > best.score) best = { row, score, lex };
  }

  if (best && (best.score >= ENTITY_MERGE_THRESHOLD || best.lex >= LEXICAL_EXACT_FAST_PATH)) {
    return {
      entity: rowToEntity(best.row),
      created: false,
      score: best.score
    };
  }

  const created = insertEntity(instance, {
    bankId,
    canonicalName: surface,
    entityType: type
  });
  return { entity: created, created: true, score: best?.score ?? 0 };
}

function scoreCandidate(
  db: Database,
  candidate: CandidateEntity,
  surface: string,
  context: { recentUnitIds?: string[]; mentionedAt?: string } | undefined,
  precomputedLex?: number
): number {
  const lex = precomputedLex ?? lexicalSimilarity(candidate.canonical_name, surface);
  let cooc = 0;
  let temp = 0;

  if (context?.recentUnitIds && context.recentUnitIds.length > 0) {
    const placeholders = context.recentUnitIds.map(() => "?").join(",");
    const row = db
      .query<{ c: number }, string[]>(
        `SELECT COUNT(*) AS c FROM entity_mentions WHERE entity_id = ? AND unit_id IN (${placeholders})`
      )
      .get(candidate.id, ...context.recentUnitIds);
    cooc = row && row.c > 0 ? Math.min(1, row.c / context.recentUnitIds.length) : 0;
  }

  if (context?.mentionedAt) {
    const row = db
      .query<{ mentioned_at: string }, [string]>(
        `SELECT mu.mentioned_at FROM entity_mentions em
         JOIN memory_units mu ON mu.id = em.unit_id
         WHERE em.entity_id = ?
         ORDER BY mu.mentioned_at DESC
         LIMIT 1`
      )
      .get(candidate.id);
    if (row?.mentioned_at) {
      const newest = Date.parse(row.mentioned_at);
      const target = Date.parse(context.mentionedAt);
      if (!isNaN(newest) && !isNaN(target)) {
        const days = Math.abs(target - newest) / 86400_000;
        // 0 days -> 1.0; 30 days -> ~0.5; 90 days -> ~0.25
        temp = 1 / (1 + days / 30);
      }
    }
  }

  return (
    ENTITY_RESOLUTION_WEIGHTS.alpha * lex +
    ENTITY_RESOLUTION_WEIGHTS.beta * cooc +
    ENTITY_RESOLUTION_WEIGHTS.gamma * temp
  );
}

// Normalized Levenshtein. Returns 1.0 for identical, 0 for unrelated. Case-
// insensitive — entity names are matched on display form post-lowercase.
export function lexicalSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const la = a.trim().toLowerCase();
  const lb = b.trim().toLowerCase();
  if (la === lb) return 1;
  if (!la || !lb) return 0;
  const distance = levenshtein(la, lb);
  return 1 - distance / Math.max(la.length, lb.length);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function rowToEntity(row: CandidateEntity): Entity {
  return {
    id: row.id,
    bankId: row.bank_id,
    canonicalName: row.canonical_name,
    entityType: row.entity_type,
    createdAt: row.created_at
  };
}

export type { Entity };
