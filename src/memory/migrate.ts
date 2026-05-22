// Legacy MemoryRecord → Hindsight migration helper.
//
// Originally drained `state.memories` rows into the Hindsight SQLite
// store. The `state.memories` surface was removed alongside the
// state.memories consolidation (see ADR memory-surface-consolidation.md);
// the consolidation's own one-shot migration in
// `migrate-pinned-to-user-md.ts` now drains every active pinned row
// into USER.md before this helper would run.
//
// The exported functions stay so `/api/memory/migrate` and the
// `gini memory migrate` CLI surface keep returning a structured report
// without breaking older callers. They now report a no-op result.

import type { RuntimeConfig } from "../types";

export interface MigrationReport {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  errors: Array<{ memoryId: string; error: string }>;
  unitIds: string[];
}

export async function migrateLegacyMemories(_config: RuntimeConfig): Promise<MigrationReport> {
  return {
    total: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    unitIds: []
  };
}

// Used by `gini start` to opportunistically migrate. Returns null because
// there is nothing left to migrate post-consolidation.
export async function migrateIfNeeded(_config: RuntimeConfig): Promise<MigrationReport | null> {
  return null;
}

// Helper exposed to UI. The legacy panel that consumed this was removed
// alongside the consolidation; the helper stays so older callers don't
// crash and reports "no pinned memories left to migrate".
export function legacyMigrationStatus(_memories: unknown): {
  total: number;
  migrated: number;
  pending: number;
  fullyMigrated: boolean;
} {
  return { total: 0, migrated: 0, pending: 0, fullyMigrated: true };
}

// Re-exported under a more conventional name for the CLI command.
export { migrateLegacyMemories as migrate };
