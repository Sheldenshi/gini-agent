// Legacy MemoryRecord → Hindsight migration helper.
//
// Originally drained `state.memories` rows into the Hindsight SQLite
// store. The `state.memories` surface was removed alongside the
// state.memories consolidation (see ADR runtime-identity-files.md);
// the consolidation's own one-shot migration in
// `migrate-pinned-to-user-md.ts` now drains every active pinned row
// into USER.md before this helper would run.
//
// The exported functions stay so `/api/memory/migrate` and the
// `gini memory migrate` CLI surface keep returning a structured report
// without breaking older callers. They explicitly report a no-op result
// — there is no pinned-memory work left to do, the install-time
// migration already drained the array.

import type { RuntimeConfig } from "../types";

export interface MigrationReport {
  skipped: true;
  reason: string;
}

export async function migrateLegacyMemories(_config: RuntimeConfig): Promise<MigrationReport> {
  return {
    skipped: true,
    reason: "pinned-memory migration ran during install; no legacy rows remain to drain into Hindsight"
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
