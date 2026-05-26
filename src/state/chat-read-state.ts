// Per-credential chat read-state. Records the last block id each
// credential has acknowledged seeing on each chat session, so the iOS
// app can show a badge count for unread activity across sessions.
//
// Backing store: the `chat_read_state` SQLite table created in
// src/state/memory-db.ts:applyMigrations step 6. One row per
// (session_id, credential_id) tuple. Updates are upserts — the mobile
// client POSTs the most recent block id every time the user opens a
// chat detail, and we record it idempotently.
//
// "Visible" kinds: the unread count only includes block kinds the
// mobile chat detail screen renders standalone. `tool_result` blocks
// surface via their paired `tool_call`'s expand affordance, so they
// don't count as their own unread item. Everything else the user
// actually sees on screen (user_text, assistant_text, tool_call,
// phase, approval_requested, system_note) is counted.

import type { Instance } from "../types";
import { now } from "./ids";
import { getMemoryDb } from "./memory-db";

// Block kinds the chat detail renders as their own row. Mirrors the
// filter logic in mobile/app/chat/[sessionId].tsx — `tool_result`
// blocks are pulled into their paired `tool_call`'s expanded view
// rather than rendering standalone, so they don't count as their own
// unread item. `phase` is included because the badge math triggers
// on terminal phase blocks (Completed / Failed) — those are real
// state changes the user wants to see reflected.
const COUNTABLE_KINDS = [
  "user_text",
  "assistant_text",
  "tool_call",
  "phase",
  "approval_requested",
  "system_note"
] as const;

export interface ChatReadState {
  sessionId: string;
  credentialId: string;
  lastReadBlockId: string;
  updatedAt: string;
}

interface ChatReadStateRow {
  session_id: string;
  credential_id: string;
  last_read_block_id: string;
  updated_at: string;
}

function rowToState(row: ChatReadStateRow): ChatReadState {
  return {
    sessionId: row.session_id,
    credentialId: row.credential_id,
    lastReadBlockId: row.last_read_block_id,
    updatedAt: row.updated_at
  };
}

// Mark a session as read up to (and including) the given block id for
// the calling credential. Idempotent — replays of the same blockId
// only bump updated_at; later block ids advance the cursor.
//
// Caller is expected to have already validated that `blockId` belongs
// to `sessionId` (the HTTP route does this so the gateway can return
// a clean 400). This module trusts the inputs.
export function markRead(
  instance: Instance,
  sessionId: string,
  credentialId: string,
  blockId: string
): ChatReadState {
  const db = getMemoryDb(instance);
  const at = now();
  db.run(
    `INSERT INTO chat_read_state (session_id, credential_id, last_read_block_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, credential_id) DO UPDATE SET
       last_read_block_id = excluded.last_read_block_id,
       updated_at = excluded.updated_at`,
    [sessionId, credentialId, blockId, at]
  );
  return {
    sessionId,
    credentialId,
    lastReadBlockId: blockId,
    updatedAt: at
  };
}

// Returns the per-session last-read cursor for a credential as a Map
// keyed by sessionId. Used to compute unread counts and to feed the
// silent-push suppression check.
export function getLastReadByCredential(
  instance: Instance,
  credentialId: string
): Map<string, string> {
  const db = getMemoryDb(instance);
  const rows = db
    .query<ChatReadStateRow, [string]>(
      "SELECT * FROM chat_read_state WHERE credential_id = ?"
    )
    .all(credentialId);
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.session_id, row.last_read_block_id);
  }
  return map;
}

// Returns the (sessionId, credentialId) read-state row, or null if the
// credential has never opened the session. Exposed for the HTTP read
// endpoint's response.
export function getReadState(
  instance: Instance,
  sessionId: string,
  credentialId: string
): ChatReadState | null {
  const db = getMemoryDb(instance);
  const row = db
    .query<ChatReadStateRow, [string, string]>(
      "SELECT * FROM chat_read_state WHERE session_id = ? AND credential_id = ?"
    )
    .get(sessionId, credentialId);
  return row ? rowToState(row) : null;
}

// Total unread COUNTABLE_KINDS blocks across every session for the
// credential. A session with no chat_read_state row counts the entire
// session as unread (the user has never seen any blocks in it). For
// sessions WITH a row, unread = blocks with ordinal > cursor block's
// ordinal.
//
// Single SQL trip via two CTEs:
//   - `cursors` joins the credential's last-read rows to the cursor
//     block's ordinal so we have one row per session with the cutoff
//     ordinal (or NULL if the session has no read-state row).
//   - The outer aggregate counts visible blocks per session whose
//     ordinal exceeds the cutoff, treating NULL cutoff as -1 so
//     fresh sessions count every visible block.
export function unreadCountForCredential(
  instance: Instance,
  credentialId: string
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
         WHERE crs.credential_id = ?
       )
       SELECT COUNT(*) AS unread
       FROM chat_blocks b
       LEFT JOIN cursor_ordinals co ON co.session_id = b.session_id
       WHERE b.kind IN (${kindList})
         AND b.ordinal > COALESCE(co.cutoff_ordinal, -1)`
    )
    .get(credentialId);
  return row?.unread ?? 0;
}
