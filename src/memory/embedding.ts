// Embedding-provider domain helpers: status report + reembed walk.
//
// Status: snapshot of which provider is active, what model it uses, how big
// the local cache is, and per-bank model breakdowns so the user can see
// whether semantic recall will actually find their units (cross-model
// vectors are filtered out).
//
// Reembed: walks all active memory units in a bank, re-embeds each with the
// currently-selected provider, and updates the embedding/embedding_dim/
// embedding_model triple. Audit-logged via addAudit so the
// invariant "audit events for embedding mutations" holds.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import {
  DEFAULT_BANK_ID,
  addAudit,
  countUnitsByEmbeddingModel,
  ensureDefaultBank,
  listBanks,
  listMemoryUnits,
  mutateState,
  updateMemoryUnitEmbedding,
  type EmbeddingModelCount
} from "../state";
import {
  getEmbeddingProvider,
  localCacheDir,
  resolveEmbeddingChoice,
  type EmbeddingChoice
} from "../embeddings";

export interface EmbeddingStatus {
  provider: EmbeddingChoice;
  cache: { dir: string; exists: boolean; sizeBytes: number };
  byBank: EmbeddingModelCount[];
  // True when at least one bank has units whose embedding_model differs from
  // the active provider's model. Surface this as a reembed recommendation.
  modelMismatch: boolean;
}

export function embeddingStatus(config: RuntimeConfig): EmbeddingStatus {
  ensureDefaultBank(config.instance);
  const provider = resolveEmbeddingChoice(config);
  const dir = provider.cacheDir ?? localCacheDir();
  const cache = { dir, exists: existsSync(dir), sizeBytes: existsSync(dir) ? dirSize(dir) : 0 };
  const byBank = countUnitsByEmbeddingModel(config.instance);
  const modelMismatch = byBank.some(
    (row) => row.embeddingModel !== null && row.embeddingModel !== provider.model
  );
  return { provider, cache, byBank, modelMismatch };
}

// Recursive directory size — small dir (single model), one-level
// readdirSync per dir is fine.
function dirSize(path: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      try {
        const st = statSync(child);
        if (st.isDirectory()) total += dirSize(child);
        else total += st.size;
      } catch { /* ignore stat failures (broken symlinks etc.) */ }
    }
  } catch { /* ignore readdir failures */ }
  return total;
}

export interface ReembedInput {
  bankId?: string;
  dryRun?: boolean;
}

export interface ReembedReport {
  bankId: string;
  provider: { name: string; model: string };
  totalUnits: number;
  dryRun: boolean;
  // count of units whose embedding_model already matches the active provider's
  // model — these get re-embedded too so a model-id rename still produces a
  // refreshed vector (cheap and predictable). If you only want to migrate the
  // mismatched subset, filter on `byCurrentModel` first via `gini embedding
  // status` and skip the call.
  alreadyOnModel: number;
  // count of units whose embedding_model differs (or is null) — the whole
  // point of running reembed.
  migrated: number;
  failed: number;
}

export async function reembedBank(config: RuntimeConfig, input: ReembedInput): Promise<ReembedReport> {
  ensureDefaultBank(config.instance);
  const bankId = input.bankId ?? DEFAULT_BANK_ID;
  const provider = getEmbeddingProvider(config);
  const units = listMemoryUnits(config.instance, bankId, { limit: 100000 });
  const dryRun = input.dryRun === true;
  let migrated = 0;
  let alreadyOnModel = 0;
  let failed = 0;

  // Batch by provider's batch size — providers handle their own batching, so
  // we just feed reasonable groups (50) of texts at a time. Local provider
  // is sequential per-call internally; openai batches up to 100; echo is
  // pure CPU.
  const BATCH = 50;
  for (let start = 0; start < units.length; start += BATCH) {
    const chunk = units.slice(start, start + BATCH);
    const texts = chunk.map((unit) => unit.text);
    let vectors: Float32Array[];
    try {
      vectors = dryRun ? [] : await provider.embed(texts);
    } catch {
      failed += chunk.length;
      continue;
    }
    for (let i = 0; i < chunk.length; i++) {
      const unit = chunk[i]!;
      const isCurrent = unit.embeddingModel === provider.model && unit.embeddingDim === provider.dim;
      if (isCurrent) alreadyOnModel += 1;
      if (!dryRun) {
        const vector = vectors[i] ?? null;
        if (!vector) { failed += 1; continue; }
        updateMemoryUnitEmbedding(config.instance, unit.id, vector, provider.model);
      }
      migrated += 1;
    }
  }

  // Audit (mutate state so the event hits the audit log + the runtime event
  // stream, matching the invariant that embedding mutations are audited).
  await mutateState(config.instance, (state) => {
    // Embedding reembed is an operator-driven maintenance pass over a
    // bank; the audit row records the model migration rather than any
    // agent's runtime activity.
    addAudit(
      state,
      {
        actor: "runtime",
        action: dryRun ? "embedding.reembed.dry-run" : "embedding.reembed",
        target: bankId,
        risk: "low",
        evidence: {
          provider: provider.name,
          model: provider.model,
          units: units.length,
          migrated,
          alreadyOnModel,
          failed
        }
      },
      { system: true }
    );
  });

  return {
    bankId,
    provider: { name: provider.name, model: provider.model },
    totalUnits: units.length,
    dryRun,
    alreadyOnModel,
    migrated,
    failed
  };
}

// Reembed every bank known to the instance's memory.db. Useful after
// openclaw migration, which routes Hindsight units into per-agent
// banks (`bank_<agentId>`) — a plain `gini embedding reembed` only
// walks `bank_default` and leaves the per-agent banks unembedded
// (semantic recall returns nothing). This helper enumerates
// `listBanks` and reembeds each, returning the per-bank reports so
// the CLI can render an aggregate summary.
export async function reembedAllBanks(
  config: RuntimeConfig,
  input: { dryRun?: boolean } = {}
): Promise<ReembedReport[]> {
  ensureDefaultBank(config.instance);
  const banks = listBanks(config.instance);
  if (banks.length === 0) return [];
  const reports: ReembedReport[] = [];
  for (const bank of banks) {
    reports.push(await reembedBank(config, { bankId: bank.id, dryRun: input.dryRun }));
  }
  return reports;
}

// Used by `gini doctor` to flag any bank that has units in a model that
// isn't the currently-active provider's model.
export function listBanksWithModelMismatch(config: RuntimeConfig): EmbeddingModelCount[] {
  const provider = resolveEmbeddingChoice(config);
  const banks = listBanks(config.instance).map((bank) => bank.id);
  if (banks.length === 0) return [];
  const all = countUnitsByEmbeddingModel(config.instance);
  return all.filter(
    (row) => row.embeddingModel !== null && row.embeddingModel !== provider.model && row.count > 0
  );
}
