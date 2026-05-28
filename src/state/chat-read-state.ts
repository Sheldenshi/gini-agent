// Per-device chat read-state. Records the last block id each device
// has acknowledged seeing on each chat session, so the iOS app can
// show a badge count for unread activity across sessions.
//
// Why device-keyed (not credential-keyed): the runtime credential
// model collapses every device owned by the same human onto one
// credential id ("owner" for the runtime config token, the paired
// device id for the pairing flow). Two iPhones owned by the same
// human would otherwise share one read cursor — opening a chat on
// iPhone A would clear iPhone B's badge for that session, even
// though iPhone B's user has not actually seen the new blocks. Keying
// on the device's APNs token gives each install its own per-session
// cursor.
//
// Backing store: the `chat_read_state` SQLite table created in
// src/state/memory-db.ts:applyMigrations step 6. One row per
// (session_id, device_token) tuple. Updates are upserts — the mobile
// client POSTs the most recent block id every time the user opens a
// chat detail (with the device's APNs token in X-Device-Token), and
// we record it idempotently.
//
// "Visible" kinds: the unread count only includes block kinds the
// mobile chat detail screen renders standalone. `tool_result` blocks
// surface via their paired `tool_call`'s expand affordance, so they
// don't count as their own unread item. Everything else the user
// actually sees on screen (user_text, assistant_text, tool_call,
// approval_requested, system_note) is counted. Phase blocks are
// excluded — the chat detail filters out historical phases (and
// terminal labels Completed/Cancelled/Failed), so they're not visible
// to the user and shouldn't drive a badge.

import type { Instance } from "../types";
import { now } from "./ids";
import { getMemoryDb } from "./memory-db";

const COUNTABLE_KINDS = [
  "user_text",
  "assistant_text",
  "tool_call",
  "approval_requested",
  "system_note"
] as const;

export interface ChatReadState {
  sessionId: string;
  deviceToken: string;
  lastReadBlockId: string;
  updatedAt: string;
}

interface ChatReadStateRow {
  session_id: string;
  device_token: string;
  last_read_block_id: string;
  updated_at: string;
}

function rowToState(row: ChatReadStateRow): ChatReadState {
  return {
    sessionId: row.session_id,
    deviceToken: row.device_token,
    lastReadBlockId: row.last_read_block_id,
    updatedAt: row.updated_at
  };
}

// Mark a session as read up to (and including) the given block id for
// the calling device. Idempotent — replays of the same blockId only
// bump updated_at. The cursor is monotonic: a later block id (higher
// ordinal) advances it; an EARLIER block id is a no-op so that, e.g.,
// a stale tap on an older chat detail doesn't regress a fresh cursor
// from another action on the same device.
//
// Caller is expected to have already validated that `blockId` belongs
// to `sessionId` (the HTTP route does this so the gateway can return
// a clean 400). This module trusts the inputs.
export function markRead(
  instance: Instance,
  sessionId: string,
  deviceToken: string,
  blockId: string
): ChatReadState {
  const db = getMemoryDb(instance);
  const at = now();

  // Monotonicity guard: look up the candidate block's ordinal and the
  // current cursor's ordinal (if any). If the candidate is earlier in
  // the session than the existing cursor, leave the row alone and
  // return the existing state. Without this, a delayed network write
  // of an older block id (replay, race) could move the cursor
  // backwards and re-inflate the badge.
  const candidate = db
    .query<{ ordinal: number }, [string, string]>(
      "SELECT ordinal FROM chat_blocks WHERE id = ? AND session_id = ?"
    )
    .get(blockId, sessionId);

  const existing = db
    .query<ChatReadStateRow & { cursor_ordinal: number | null }, [string, string]>(
      `SELECT crs.*, cb.ordinal AS cursor_ordinal
       FROM chat_read_state crs
       LEFT JOIN chat_blocks cb ON cb.id = crs.last_read_block_id
       WHERE crs.session_id = ? AND crs.device_token = ?`
    )
    .get(sessionId, deviceToken);

  if (
    existing &&
    candidate &&
    existing.cursor_ordinal !== null &&
    candidate.ordinal < existing.cursor_ordinal
  ) {
    // Candidate is older than what's already stored — no-op silently.
    return rowToState(existing);
  }

  db.run(
    `INSERT INTO chat_read_state (session_id, device_token, last_read_block_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, device_token) DO UPDATE SET
       last_read_block_id = excluded.last_read_block_id,
       updated_at = excluded.updated_at`,
    [sessionId, deviceToken, blockId, at]
  );
  return {
    sessionId,
    deviceToken,
    lastReadBlockId: blockId,
    updatedAt: at
  };
}

// Clear the per-device read cursor for a session so the badge counts
// the entire session as unread again. Idempotent — calling on a row
// that doesn't exist is a no-op. Used by the mobile "mark unread"
// swipe action: the cursor's monotonicity guard prevents moving it
// backwards by replaying an older block id, so the only honest way
// to flip a chat back to unread for the device is to drop the row.
export function clearReadState(
  instance: Instance,
  sessionId: string,
  deviceToken: string
): void {
  const db = getMemoryDb(instance);
  db.run(
    "DELETE FROM chat_read_state WHERE session_id = ? AND device_token = ?",
    [sessionId, deviceToken]
  );
}

// Returns the per-session last-read cursor for a device as a Map
// keyed by sessionId.
export function getLastReadByDevice(
  instance: Instance,
  deviceToken: string
): Map<string, string> {
  const db = getMemoryDb(instance);
  const rows = db
    .query<ChatReadStateRow, [string]>(
      "SELECT * FROM chat_read_state WHERE device_token = ?"
    )
    .all(deviceToken);
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.session_id, row.last_read_block_id);
  }
  return map;
}

// Returns the (sessionId, deviceToken) read-state row, or null if the
// device has never opened the session. Exposed for the HTTP read
// endpoint's response.
export function getReadState(
  instance: Instance,
  sessionId: string,
  deviceToken: string
): ChatReadState | null {
  const db = getMemoryDb(instance);
  const row = db
    .query<ChatReadStateRow, [string, string]>(
      "SELECT * FROM chat_read_state WHERE session_id = ? AND device_token = ?"
    )
    .get(sessionId, deviceToken);
  return row ? rowToState(row) : null;
}

// Total unread COUNTABLE_KINDS blocks across every session for the
// device. A session with no chat_read_state row counts the entire
// session as unread (this device has never seen any blocks in it).
// For sessions WITH a row, unread = blocks with ordinal > cursor
// block's ordinal.
//
// Single SQL trip via two CTEs:
//   - `cursors` joins the device's last-read rows to the cursor
//     block's ordinal so we have one row per session with the cutoff
//     ordinal (or NULL if the session has no read-state row).
//   - The outer aggregate counts visible blocks per session whose
//     ordinal exceeds the cutoff, treating NULL cutoff as -1 so
//     fresh sessions count every visible block.
export function unreadCountForDevice(
  instance: Instance,
  deviceToken: string
): number {
  const db = getMemoryDb(instance);
  // SQLite parameter binding doesn't accept arrays for IN clauses, so
  // we expand the kind list inline. Using a constant list of literals
  // is safe — no user input flows in.
  const kindList = COUNTABLE_KINDS.map((k) => `'${k}'`).join(",");
  const row = db
    .query<{ unread: number }, [string]>(
      `WITH cursor_ordinals AS (
         SELECT crs.session_id, cb.ordinal AS cutoff_ordinal
         FROM chat_read_state crs
         LEFT JOIN chat_blocks cb ON cb.id = crs.last_read_block_id
         WHERE crs.device_token = ?
       )
       SELECT COUNT(*) AS unread
       FROM chat_blocks b
       LEFT JOIN cursor_ordinals co ON co.session_id = b.session_id
       WHERE b.kind IN (${kindList})
         AND b.ordinal > COALESCE(co.cutoff_ordinal, -1)`
    )
    .get(deviceToken);
  return row?.unread ?? 0;
}
