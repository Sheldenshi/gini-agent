// Hindsight phase 6 — one-time migration from the legacy MemoryRecord JSON
// store into the four-network SQLite store.
//
// Heuristic mapping:
//   - scope    -> stays in record metadata as `legacyScope`. Future work may
//                 namespace banks per project/user; v1 lumps everything into
//                 the instance's default bank.
//   - content  -> embedded with the current provider, inserted as a
//                 MemoryUnit. Network classified by a tiny rule:
//                   first-person language ("I ", "did ", "recommended ",
//                   "observed ", "noticed ") -> experience
//                   anything else            -> world
//                 Opinions get migrated as world by default to stay
//                 conservative; the user can promote them in the UI.
//   - confidence -> carried over verbatim.
//   - sourceTaskId / sourceSessionId -> mapped 1:1.
//   - status     -> 'active' if the legacy row was active, 'archived' for
//                  archived/rejected; 'proposed' rows aren't migrated yet
//                  (left in the legacy store for human curation).
//
// Idempotency: each legacy record's metadata gets `migratedToUnitId` set on
// success. Re-running the migration skips records that already have it.
//
// Failure mode: per-record errors are collected and reported but do not
// abort the migration. Startup auto-trigger calls this and surfaces the
// failure in `gini doctor` rather than blocking.

import type { Instance, MemoryRecord, RuntimeConfig } from "../types";
import {
  DEFAULT_BANK_ID,
  bankIdForAgent,
  ensureAgentBank,
  ensureDefaultBank,
  insertMemoryUnit,
  mutateState,
  now,
  readState
} from "../state";
import { getEmbeddingProvider } from "../embeddings";

export interface MigrationReport {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  errors: Array<{ memoryId: string; error: string }>;
  unitIds: string[];
}

const EXPERIENCE_HINTS = [
  /^i\b/i,
  /\bi did\b/i,
  /\brecommended\b/i,
  /\bobserved\b/i,
  /\bnoticed\b/i,
  /\bi tried\b/i,
  /\bi prefer\b/i
];

function classifyNetwork(content: string): "world" | "experience" {
  for (const hint of EXPERIENCE_HINTS) if (hint.test(content)) return "experience";
  return "world";
}

export async function migrateLegacyMemories(config: RuntimeConfig): Promise<MigrationReport> {
  const instance = config.instance;
  ensureDefaultBank(instance);

  // Snapshot the records to migrate. We do not run retain on each one —
  // that would burn LLM tokens at scale — just embed and insert. The
  // legacy MemoryRecord already carries `agentId` after the Phase C
  // normalizeState backfill; we use it directly so the migrated unit lands
  // in the same agent's pool.
  const snapshot = await mutateState(instance, (state) => state.memories.slice());
  const state = readState(instance);
  const fallbackAgentId = state.activeAgentId ?? state.agents[0]?.id ?? "agent_default";
  const provider = getEmbeddingProvider(config);

  const report: MigrationReport = {
    total: snapshot.length,
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    unitIds: []
  };

  for (const record of snapshot) {
    if (record.status === "proposed" || record.status === "rejected") {
      report.skipped += 1;
      continue;
    }
    if (record.metadata?.migratedToUnitId) {
      report.skipped += 1;
      continue;
    }
    try {
      const [vector] = await provider.embed([record.content]);
      const agentId = record.agentId ?? fallbackAgentId;
      ensureAgentBank(instance, agentId);
      const unit = insertMemoryUnit(instance, {
        bankId: bankIdForAgent(agentId),
        agentId,
        text: record.content,
        embedding: vector ?? null,
        embeddingModel: provider.model,
        network: classifyNetwork(record.content),
        confidence: typeof record.confidence === "number" ? record.confidence : null,
        metadata: {
          legacyScope: record.scope,
          legacyProvenance: record.provenance,
          legacyId: record.id
        },
        sourceTaskId: record.sourceTaskId ?? null,
        sourceSessionId: null,
        status: record.status === "archived" ? "archived" : "active",
        mentionedAt: record.createdAt
      });
      report.migrated += 1;
      report.unitIds.push(unit.id);
      // Mark the legacy record as migrated so re-running this migration is
      // a no-op. We keep the legacy row in JSON state so a rollback is
      // possible if the SQLite layer needs to be torn down.
      await mutateState(instance, (state) => {
        const target = state.memories.find((entry) => entry.id === record.id);
        if (!target) return;
        target.metadata = {
          ...(target.metadata ?? {}),
          migratedToUnitId: unit.id,
          migratedAt: now()
        };
        target.updatedAt = now();
      });
    } catch (error) {
      report.failed += 1;
      report.errors.push({ memoryId: record.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return report;
}

// Used by `gini start` to opportunistically migrate. Returns null if there
// is nothing to migrate (so callers can stay quiet on first run).
export async function migrateIfNeeded(config: RuntimeConfig): Promise<MigrationReport | null> {
  const memories = await mutateState(config.instance, (state) => state.memories.slice());
  const candidates = memories.filter((record) => {
    if (record.status === "proposed" || record.status === "rejected") return false;
    return !record.metadata?.migratedToUnitId;
  });
  if (candidates.length === 0) return null;
  return migrateLegacyMemories(config);
}

// Helper exposed to UI so it can hide the legacy panel once every applicable
// record has been migrated.
export function legacyMigrationStatus(memories: MemoryRecord[]): {
  total: number;
  migrated: number;
  pending: number;
  fullyMigrated: boolean;
} {
  let migrated = 0;
  let pending = 0;
  for (const record of memories) {
    if (record.status === "proposed" || record.status === "rejected") continue;
    if (record.metadata?.migratedToUnitId) migrated += 1;
    else pending += 1;
  }
  return { total: migrated + pending, migrated, pending, fullyMigrated: pending === 0 && migrated >= 0 };
}

// Re-exported under a more conventional name for the CLI command.
export { migrateLegacyMemories as migrate };
