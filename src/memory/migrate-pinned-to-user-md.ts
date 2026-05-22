// One-shot migration: drain the legacy `state.memories` pinned-memory store
// into the instance-scoped USER.md and clear the array.
//
// Idempotency lives on `state.migrations.statePinnedToUserMd` — once set, the
// migration is a no-op. Failure of any kind (filesystem unwritable, race with
// a concurrent edit) leaves the marker UNSET and the array intact so the next
// startup retries.
//
// Migration order matters: `install()` must call this AFTER
// `scaffoldInstanceIdentityFiles` (which materializes the zero-byte
// USER.md placeholder) so the append path always has a file to write
// against. See ADR memory-surface-consolidation.md.

import { existsSync, readFileSync } from "node:fs";
import type { Instance, RuntimeConfig } from "../types";
import { mutateState, readState } from "../state";
import { addAudit } from "../state/audit";
import { appendLog } from "../state/trace";
import { writeUserProfile, userProfilePath } from "../runtime/identity-files";

export interface MigrationReport {
  // True when the migration ran in this call (regardless of whether any rows
  // were actually migrated — a state file with `state.memories: []` still
  // sets the marker on the first call).
  ran: boolean;
  // Number of legacy rows folded into USER.md. Always 0 when `ran === false`.
  migrated: number;
  // ISO marker stamped on state.migrations. Present only when `ran === true`
  // AND the write succeeded.
  marker?: string;
  // Set when a filesystem or audit write failed. The marker stays unset in
  // this branch so the next startup retries; the caller logs and continues.
  error?: string;
}

const MIGRATION_HEADER_PREFIX = "<!-- migrated from pinned memories on ";

// Render the migrated section that goes underneath any existing USER.md body.
// Bullets are stripped of leading whitespace + already-present bullets so a
// hand-edited row that begins with "- " doesn't end up as "- - x".
function renderMigratedSection(contents: string[], at: string): string {
  const lines = [`${MIGRATION_HEADER_PREFIX}${at} -->`];
  for (const raw of contents) {
    const trimmed = raw.trim().replace(/^[-*]\s+/, "");
    if (trimmed.length === 0) continue;
    lines.push(`- ${trimmed}`);
  }
  return lines.join("\n");
}

// Read the current approved USER.md body. Returns "" when absent or
// unreadable so the append path can concatenate without a null check.
// We deliberately do NOT route through `loadUserProfile` because that
// applies the injection scan and may return a `[BLOCKED: ...]` notice —
// the migration should write to the real file, not stack content under a
// blocked-content placeholder.
function readApprovedUserProfile(instance: Instance): string {
  const path = userProfilePath(instance);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// Drain `state.memories` into USER.md. Idempotent via the
// `state.migrations.statePinnedToUserMd` marker. Best-effort: a thrown
// error is captured in the returned report (the runtime keeps booting).
//
// Migration semantics:
//   - Only rows with status === "active" are migrated. Proposed and
//     rejected/archived rows are dropped along with the rest of the array.
//   - Per-agent scoping is lost (USER.md is instance-scoped). Pinned
//     identity facts SHOULD have been cross-agent in the first place —
//     that's the whole reason for the consolidation. See ADR
//     memory-surface-consolidation.md.
//   - Bullets are deduplicated by exact content match so re-runs of the
//     migration on a partially-cleaned state file don't produce duplicate
//     rows. (The marker should prevent this — defense in depth.)
export async function migratePinnedMemoriesToUserProfile(
  config: RuntimeConfig
): Promise<MigrationReport> {
  // Read-only snapshot to decide whether the migration needs to run at all.
  // Avoids burning a mutateState window when the marker is already set.
  const initial = readState(config.instance);
  const existing = (initial as unknown as { migrations?: { statePinnedToUserMd?: string } }).migrations;
  if (existing?.statePinnedToUserMd) {
    return { ran: false, migrated: 0 };
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const memory of initial.memories ?? []) {
    if (memory.status !== "active") continue;
    const text = (memory.content ?? "").trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    candidates.push(text);
  }

  const at = new Date().toISOString();
  let appendedBody = "";
  if (candidates.length > 0) {
    const existingBody = readApprovedUserProfile(config.instance).trim();
    const migratedSection = renderMigratedSection(candidates, at);
    appendedBody = existingBody.length > 0
      ? `${existingBody}\n\n${migratedSection}\n`
      : `${migratedSection}\n`;
    try {
      // Auto-approved write — same semantics edit_user_profile uses
      // after the consolidation. The injection scan runs on the new
      // body; flagged content still writes (fail-soft, matches the
      // pre-change posture).
      writeUserProfile(config.instance, appendedBody, "approved");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        appendLog(config.instance, "memory.pinned.migration.failed", {
          stage: "write-user-md",
          candidates: candidates.length,
          error: message
        });
      } catch {
        // Swallow — logging itself failing must not crash startup.
      }
      return { ran: false, migrated: 0, error: message };
    }
  }

  try {
    await mutateState(config.instance, (state) => {
      const migratedIds = (state.memories ?? [])
        .filter((memory) => memory.status === "active")
        .map((memory) => memory.id);
      state.memories = [];
      const stateWithMigrations = state as unknown as {
        migrations?: { statePinnedToUserMd?: string };
      };
      stateWithMigrations.migrations = {
        ...(stateWithMigrations.migrations ?? {}),
        statePinnedToUserMd: at
      };
      addAudit(
        state,
        {
          actor: "runtime",
          action: "memory.pinned.migrated",
          target: userProfilePath(config.instance),
          risk: "low",
          evidence: {
            migrated: candidates.length,
            migratedIds,
            marker: at
          }
        },
        { system: true }
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      appendLog(config.instance, "memory.pinned.migration.failed", {
        stage: "state-write",
        candidates: candidates.length,
        error: message
      });
    } catch {
      // Swallow.
    }
    return { ran: false, migrated: 0, error: message };
  }

  return { ran: true, migrated: candidates.length, marker: at };
}
