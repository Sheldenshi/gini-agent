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
// against. See ADR runtime-identity-files.md.

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
// `state.migrations.statePinnedToUserMd` marker AND, as defense in
// depth, by inspecting USER.md for the header this migration writes so
// a crash between the file write and the marker stamp does not lead to
// a double-append on the next startup.
//
// Best-effort: a thrown error is captured in the returned report (the
// runtime keeps booting). Malformed `state.memories` rows (anything
// other than `{ content: string, status: string }`) are skipped, never
// throw.
//
// Migration semantics:
//   - Only rows with status === "active" are migrated. Proposed and
//     rejected/archived rows are dropped along with the rest of the array.
//   - Per-agent scoping is lost (USER.md is instance-scoped). Pinned
//     identity facts SHOULD have been cross-agent in the first place —
//     that's the whole reason for the consolidation. See ADR
//     runtime-identity-files.md.
//   - Bullets are deduplicated by exact content match so re-runs of the
//     migration on a partially-cleaned state file don't produce duplicate
//     rows. (The marker should prevent this — defense in depth.)
export async function migratePinnedMemoriesToUserProfile(
  config: RuntimeConfig
): Promise<MigrationReport> {
  try {
    return await runMigration(config);
  } catch (error) {
    // Catch-all guard. The body below already wraps every IO seam in
    // its own try/catch, but a malformed state.memories row (e.g.
    // `status` is not a string) could throw inside the per-row loop —
    // the marker stays unset so the next startup retries, and the
    // gateway keeps booting either way.
    const message = error instanceof Error ? error.message : String(error);
    try {
      appendLog(config.instance, "memory.pinned.migration.failed", {
        stage: "unexpected",
        error: message
      });
    } catch {
      // Swallow — logging itself failing must not crash startup.
    }
    return { ran: false, migrated: 0, error: message };
  }
}

async function runMigration(config: RuntimeConfig): Promise<MigrationReport> {
  // Read-only snapshot to decide whether the migration needs to run at all.
  // Avoids burning a mutateState window when the marker is already set.
  const initial = readState(config.instance);
  const dyn = initial as unknown as {
    migrations?: { statePinnedToUserMd?: string };
    memories?: unknown;
  };
  if (dyn.migrations?.statePinnedToUserMd) {
    return { ran: false, migrated: 0 };
  }

  // Crash-idempotency check: a previous run may have written USER.md
  // before the marker landed. Skip the file write (but still stamp the
  // marker + clear the array below) if USER.md already carries our
  // migration header.
  const existingBody = readApprovedUserProfile(config.instance);
  const alreadyAppended = existingBody.includes(MIGRATION_HEADER_PREFIX);

  // Robust shape extraction: tolerate malformed rows. Anything that
  // isn't a `{ status: "active", content: string }` is silently
  // dropped. The migration MUST NOT crash on a hand-edited state file.
  const candidates: string[] = [];
  const candidateIds: string[] = [];
  const seen = new Set<string>();
  const rawMemories = Array.isArray(dyn.memories) ? dyn.memories : [];
  for (const entry of rawMemories) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (row.status !== "active") continue;
    const text = typeof row.content === "string" ? row.content.trim() : "";
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    candidates.push(text);
    candidateIds.push(typeof row.id === "string" ? row.id : `mem_unknown_${candidates.length}`);
  }

  const at = new Date().toISOString();
  if (candidates.length > 0 && !alreadyAppended) {
    const trimmed = existingBody.trim();
    const migratedSection = renderMigratedSection(candidates, at);
    const appendedBody = trimmed.length > 0
      ? `${trimmed}\n\n${migratedSection}\n`
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
      const stateDyn = state as unknown as {
        memories?: unknown;
        migrations?: { statePinnedToUserMd?: string };
      };
      stateDyn.memories = [];
      stateDyn.migrations = {
        ...(stateDyn.migrations ?? {}),
        statePinnedToUserMd: at
      };
      // Per-row audit so operators can see exactly which pinned memory
      // landed in USER.md. The ADR for the consolidation calls for the
      // per-row + summary breakdown; the summary row follows below.
      for (let i = 0; i < candidates.length; i += 1) {
        addAudit(
          state,
          {
            actor: "runtime",
            action: "memory.pinned.migrated.row",
            target: userProfilePath(config.instance),
            risk: "low",
            evidence: {
              memoryId: candidateIds[i],
              content: candidates[i],
              marker: at
            }
          },
          { system: true }
        );
      }
      addAudit(
        state,
        {
          actor: "runtime",
          action: "memory.pinned.migrated",
          target: userProfilePath(config.instance),
          risk: "low",
          evidence: {
            migrated: candidates.length,
            migratedIds: candidateIds,
            marker: at,
            alreadyAppended
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
