// Chat block persistence and pub-sub. Implements the storage half of the
// ChatBlock protocol described in ADR chat-block-protocol.md.
//
// Storage shape: one row per block in the SQLite `chat_blocks` table (see
// memory-db.ts:applyMigrations step 4 for the schema). Each row carries
// the typed payload as JSON in `payload_json` plus denormalized columns
// (session_id, ordinal, kind, task_id, run_id, agent_id, created_at,
// updated_at) for indexable queries. The schema's UNIQUE (session_id,
// ordinal) constraint plus the per-session SELECT-MAX-then-INSERT
// transaction guarantees a single monotonic stream of ordinals even
// under interleaved writers.
//
// Pub-sub: insertChatBlock / upsertChatBlock fire a single EventEmitter
// event per session AFTER the SQLite commit, so subscribers (the SSE
// route in src/http.ts) observe rows that are already durable. Listeners
// are best-effort — a throwing handler is logged via console.warn and
// other subscribers continue to receive the event.

import { EventEmitter } from "node:events";
import type {
  AssistantTextBlock,
  AuthorizationAction,
  ChatBlock,
  ChatBlockKind,
  Instance,
  RiskLevel,
  SetupRequestAction,
  ToolCallBlock,
  ToolCallStatus
} from "../types";
import { id, now } from "./ids";
import { getMemoryDb } from "./memory-db";

// EventEmitter shared across all (instance, sessionId) subscriptions. We
// scope events with the composite key below so different instances /
// sessions don't fan out into each other. Limit is bumped because the SSE
// route may register many concurrent subscribers across browser tabs;
// the default of 10 emits a noisy warning when the third browser tab
// opens a stream.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function subscriptionKey(instance: Instance, sessionId: string): string {
  return `${instance}::${sessionId}`;
}

// Input shape for inserting a brand-new block. Callers omit the bookkeeping
// fields (id, ordinal, createdAt, updatedAt) — those are allocated inside
// the transaction so writers never need to pre-claim ordinals. `agentId`
// is denormalized onto the row so the agent-inbox query in the API doesn't
// have to join through chat_sessions.
//
// For `assistant_text` the caller supplies `streaming: true` on the
// initial insert; subsequent deltas flow through upsertAssistantTextBlock
// with the same id. For all other kinds the row is append-only.
//
// Distribute-over-union so each branch keeps its discriminant + narrowing
// fields rather than the TS compiler collapsing the intersection into a
// shapeless rest type. `assistant_text` and `tool_call` carry an
// `updatedAt` field that's allocated on insert, so they're omitted from
// the input too.
type InsertInputFor<B extends ChatBlock> = B extends AssistantTextBlock | ToolCallBlock
  ? Omit<B, "id" | "ordinal" | "createdAt" | "updatedAt" | "instance"> & {
      agentId?: string | null;
    }
  : Omit<B, "id" | "ordinal" | "createdAt" | "instance"> & {
      agentId?: string | null;
    };
export type InsertChatBlockInput = InsertInputFor<ChatBlock>;

interface ChatBlockRow {
  id: string;
  session_id: string;
  instance: string;
  agent_id: string | null;
  ordinal: number;
  // Includes "approval_requested" as a legacy value still resident in
  // pre-split DBs (the CHECK constraint accepts it; rowToBlock migrates
  // it on read).
  kind: ChatBlockKind | "approval_requested";
  payload_json: string;
  task_id: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToBlock(row: ChatBlockRow): ChatBlock {
  // The payload column carries the typed kind-specific fields
  // (text/label/toolName/etc.). Bookkeeping fields are denormalized
  // onto their own columns so we can index them — they're re-assembled
  // here without re-reading payload_json for the canonical values.
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const base = {
    id: row.id,
    sessionId: row.session_id,
    instance: row.instance as Instance,
    ordinal: row.ordinal,
    createdAt: row.created_at,
    taskId: row.task_id ?? undefined,
    runId: row.run_id ?? undefined
  };
  switch (row.kind) {
    case "user_text": {
      const images = Array.isArray(payload.images)
        ? payload.images
            .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
            .map((item) => ({
              id: String(item.id ?? ""),
              mimeType: String(item.mimeType ?? ""),
              size: Number(item.size ?? 0)
            }))
            .filter((image) => image.id.length > 0)
        : undefined;
      return {
        ...base,
        kind: "user_text",
        text: String(payload.text ?? ""),
        ...(images && images.length > 0 ? { images } : {})
      };
    }
    case "assistant_text":
      return {
        ...base,
        kind: "assistant_text",
        updatedAt: row.updated_at,
        text: String(payload.text ?? ""),
        streaming: Boolean(payload.streaming)
      };
    case "tool_call":
      return {
        ...base,
        kind: "tool_call",
        updatedAt: row.updated_at,
        toolName: String(payload.toolName ?? ""),
        displayLabel: String(payload.displayLabel ?? payload.toolName ?? ""),
        argsPreview: String(payload.argsPreview ?? ""),
        argsFull: (payload.argsFull && typeof payload.argsFull === "object"
          ? (payload.argsFull as Record<string, unknown>)
          : {}),
        status: (payload.status as ToolCallStatus) ?? "running",
        errorMessage: typeof payload.errorMessage === "string" ? payload.errorMessage : undefined,
        callId: String(payload.callId ?? "")
      };
    case "tool_result":
      return {
        ...base,
        kind: "tool_result",
        callId: String(payload.callId ?? ""),
        preview: String(payload.preview ?? ""),
        truncated: Boolean(payload.truncated)
      };
    case "phase":
      return { ...base, kind: "phase", label: String(payload.label ?? "") };
    case "approval_requested": {
      // Legacy block kind from before the Authorization/SetupRequest split.
      // Partition by action so old rows render with the right new card
      // type. See docs/adr/authorization-vs-setup-request.md.
      const action = String(payload.action ?? "");
      if (action === "browser.connect" || action === "connector.request" || action === "browser.fill_secret") {
        return {
          ...base,
          kind: "setup_requested",
          setupRequestId: String(payload.approvalId ?? ""),
          action: action as SetupRequestAction,
          summary: String(payload.summary ?? "")
        };
      }
      return {
        ...base,
        kind: "authorization_requested",
        authorizationId: String(payload.approvalId ?? ""),
        action: action as AuthorizationAction,
        risk: (payload.risk as RiskLevel) ?? "low",
        summary: String(payload.summary ?? "")
      };
    }
    case "authorization_requested":
      return {
        ...base,
        kind: "authorization_requested",
        authorizationId: String(payload.authorizationId ?? ""),
        action: String(payload.action ?? "") as AuthorizationAction,
        risk: (payload.risk as RiskLevel) ?? "low",
        summary: String(payload.summary ?? "")
      };
    case "setup_requested":
      return {
        ...base,
        kind: "setup_requested",
        setupRequestId: String(payload.setupRequestId ?? ""),
        action: String(payload.action ?? "") as SetupRequestAction,
        summary: String(payload.summary ?? "")
      };
    case "system_note":
      return { ...base, kind: "system_note", text: String(payload.text ?? "") };
    default: {
      // Exhaustiveness guard. CHECK constraint on the kind column makes
      // this unreachable for rows we wrote, but a hand-edited DB might
      // slip a bad kind through.
      const exhaustive: never = row.kind;
      throw new Error(`Unknown chat_block kind: ${exhaustive}`);
    }
  }
}

// Build the kind-specific payload JSON. Bookkeeping fields are kept on
// dedicated columns; only the kind-specific narrowing fields go into
// the JSON blob.
function payloadFor(block: ChatBlock): string {
  switch (block.kind) {
    case "user_text":
      return JSON.stringify({
        text: block.text,
        ...(block.images && block.images.length > 0 ? { images: block.images } : {})
      });
    case "assistant_text":
      return JSON.stringify({ text: block.text, streaming: block.streaming });
    case "tool_call":
      return JSON.stringify({
        toolName: block.toolName,
        displayLabel: block.displayLabel,
        argsPreview: block.argsPreview,
        argsFull: block.argsFull,
        status: block.status,
        errorMessage: block.errorMessage,
        callId: block.callId
      });
    case "tool_result":
      return JSON.stringify({
        callId: block.callId,
        preview: block.preview,
        truncated: block.truncated
      });
    case "phase":
      return JSON.stringify({ label: block.label });
    case "authorization_requested":
      return JSON.stringify({
        authorizationId: block.authorizationId,
        action: block.action,
        risk: block.risk,
        summary: block.summary
      });
    case "setup_requested":
      return JSON.stringify({
        setupRequestId: block.setupRequestId,
        action: block.action,
        summary: block.summary
      });
    case "system_note":
      return JSON.stringify({ text: block.text });
  }
}

// Allocates the next ordinal slot for a session inside a SQLite
// transaction so concurrent writers don't both grab the same number.
// SQLite serializes writes through the per-database lock, but reading
// MAX(ordinal) and inserting must happen inside a single BEGIN/COMMIT
// pair or two writers could observe the same `next` value.
//
// The schema's UNIQUE (session_id, ordinal) constraint is the last-line
// defense against an interleave bug.
export function insertChatBlock(
  instance: Instance,
  input: InsertChatBlockInput
): ChatBlock {
  const db = getMemoryDb(instance);
  const at = now();
  const blockId = id("block");

  // SAVEPOINT lets nested mutateState callers (which already hold a write
  // lock via the JSON state file) still run this inside their own
  // transaction without conflicting. SQLite TXN nesting is otherwise
  // disallowed; SAVEPOINT works inside or outside one.
  db.exec("SAVEPOINT chat_block_insert");
  try {
    const maxRow = db
      .query<{ m: number | null }, [string]>(
        "SELECT MAX(ordinal) AS m FROM chat_blocks WHERE session_id = ?"
      )
      .get(input.sessionId);
    const nextOrdinal = (maxRow?.m ?? 0) + 1;

    // Build the canonical ChatBlock object from the input + allocated
    // fields so the persisted payload, the row, and the return value
    // all carry exactly the same data.
    const block: ChatBlock = (() => {
      const base = {
        id: blockId,
        sessionId: input.sessionId,
        instance,
        ordinal: nextOrdinal,
        createdAt: at,
        taskId: input.taskId,
        runId: input.runId
      };
      switch (input.kind) {
        case "user_text":
          return {
            ...base,
            kind: "user_text",
            text: input.text,
            ...(input.images && input.images.length > 0 ? { images: input.images } : {})
          };
        case "assistant_text":
          return {
            ...base,
            kind: "assistant_text",
            updatedAt: at,
            text: input.text,
            streaming: input.streaming
          };
        case "tool_call":
          return {
            ...base,
            kind: "tool_call",
            updatedAt: at,
            toolName: input.toolName,
            displayLabel: input.displayLabel,
            argsPreview: input.argsPreview,
            argsFull: input.argsFull,
            status: input.status,
            errorMessage: input.errorMessage,
            callId: input.callId
          };
        case "tool_result":
          return {
            ...base,
            kind: "tool_result",
            callId: input.callId,
            preview: input.preview,
            truncated: input.truncated
          };
        case "phase":
          return { ...base, kind: "phase", label: input.label };
        case "authorization_requested":
          return {
            ...base,
            kind: "authorization_requested",
            authorizationId: input.authorizationId,
            action: input.action,
            risk: input.risk,
            summary: input.summary
          };
        case "setup_requested":
          return {
            ...base,
            kind: "setup_requested",
            setupRequestId: input.setupRequestId,
            action: input.action,
            summary: input.summary
          };
        case "system_note":
          return { ...base, kind: "system_note", text: input.text };
      }
    })();

    db.run(
      `INSERT INTO chat_blocks
         (id, session_id, instance, agent_id, ordinal, kind, payload_json,
          task_id, run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        block.id,
        block.sessionId,
        instance,
        input.agentId ?? null,
        block.ordinal,
        block.kind,
        payloadFor(block),
        block.taskId ?? null,
        block.runId ?? null,
        block.createdAt,
        block.kind === "assistant_text" ? block.updatedAt : at
      ]
    );
    db.exec("RELEASE chat_block_insert");
    publish(instance, block);
    return block;
  } catch (error) {
    db.exec("ROLLBACK TO chat_block_insert");
    db.exec("RELEASE chat_block_insert");
    throw error;
  }
}

// Finds the latest in-flight (streaming) assistant_text block for a
// task. Used by the cancellation path in agent.ts to flip the row to
// `streaming: false` while preserving the partial text observed so far
// (ADR chat-block-protocol.md risks §4). Returns the block id, full
// accreted text, and session id so the caller can route both the
// finalize and the follow-on system_note through the same session.
// Returns null when the task has no chat session bound, no streaming
// row, or the schema has no chat_blocks rows yet.
export function findInFlightAssistantTextForTask(
  instance: Instance,
  taskId: string
): { blockId: string; sessionId: string; text: string } | null {
  const db = getMemoryDb(instance);
  // Search for the latest assistant_text row that's still streaming and
  // was emitted by this task. Streaming rows have `payload.streaming
  // === true`; we use json_extract because the column lives in
  // payload_json. There's at most one in practice (a single in-flight
  // assistant_text per loop iteration), but ordering by ordinal DESC
  // makes the read deterministic regardless.
  const row = db
    .query<ChatBlockRow, [string]>(
      `SELECT * FROM chat_blocks
       WHERE task_id = ? AND kind = 'assistant_text'
         AND json_extract(payload_json, '$.streaming') = 1
       ORDER BY ordinal DESC
       LIMIT 1`
    )
    .get(taskId);
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    blockId: row.id,
    sessionId: row.session_id,
    text: String(payload.text ?? "")
  };
}

// Returns true when the given task has emitted at least one
// assistant_text block whose text is non-empty after trimming. The push
// dispatcher consults this on terminal `phase: Completed` blocks to
// decide between an alert (the task produced a user-visible message) and
// a silent badge tick (only tool calls / system notes — nothing for the
// user to read). Uses LIMIT 1 + EXISTS-style early exit so the lookup
// stays O(rows-until-first-hit) rather than scanning the whole task.
export function taskProducedAssistantText(
  instance: Instance,
  taskId: string
): boolean {
  const db = getMemoryDb(instance);
  const row = db
    .query<{ payload_json: string }, [string]>(
      `SELECT payload_json FROM chat_blocks
       WHERE task_id = ? AND kind = 'assistant_text'
       ORDER BY ordinal ASC`
    )
    .all(taskId);
  for (const r of row) {
    try {
      const payload = JSON.parse(r.payload_json) as { text?: unknown };
      if (typeof payload.text === "string" && payload.text.trim().length > 0) {
        return true;
      }
    } catch {
      // malformed row — skip
    }
  }
  return false;
}

// Updates an existing assistant_text block's text + updated_at without
// allocating a new ordinal. Used by the streaming-delta path: the first
// delta inserts the block via insertChatBlock; subsequent deltas flow
// through here with the same id and the running total text so listeners
// can render a continuously growing message without splicing deltas
// client-side.
//
// Also flips `streaming: false` on the terminal delta. Callers pass the
// full accreted text — the wire contract is "carry the whole string on
// every frame" exactly so reconnect/resume is idempotent.
export function upsertAssistantTextBlock(
  instance: Instance,
  blockId: string,
  patch: { text: string; streaming: boolean }
): ChatBlock | null {
  const db = getMemoryDb(instance);
  const at = now();
  const row = db
    .query<ChatBlockRow, [string]>(
      "SELECT * FROM chat_blocks WHERE id = ? AND kind = 'assistant_text'"
    )
    .get(blockId);
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  payload.text = patch.text;
  payload.streaming = patch.streaming;
  db.run(
    `UPDATE chat_blocks
       SET payload_json = ?, updated_at = ?
     WHERE id = ?`,
    [JSON.stringify(payload), at, blockId]
  );
  const updated = rowToBlock({ ...row, payload_json: JSON.stringify(payload), updated_at: at });
  publish(instance, updated);
  return updated;
}

// Updates an existing tool_call block in place — used to flip a running
// row to `ok`, `error`, or `denied` once the dispatch resolves (and to
// stamp `errorMessage` on error). Looking up by call_id makes the resume
// path simple: the chat-task loop and the approval-resume path both
// know the provider-issued call id but not the block id.
export function updateToolCallBlock(
  instance: Instance,
  callId: string,
  sessionId: string,
  patch: {
    status: "running" | "ok" | "error" | "denied";
    errorMessage?: string;
  }
): ChatBlock | null {
  const db = getMemoryDb(instance);
  const at = now();
  const row = db
    .query<ChatBlockRow, [string, string]>(
      `SELECT * FROM chat_blocks
       WHERE session_id = ? AND kind = 'tool_call'
         AND json_extract(payload_json, '$.callId') = ?
       ORDER BY ordinal DESC
       LIMIT 1`
    )
    .get(sessionId, callId);
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  payload.status = patch.status;
  if (patch.errorMessage !== undefined) payload.errorMessage = patch.errorMessage;
  db.run(
    `UPDATE chat_blocks
       SET payload_json = ?, updated_at = ?
     WHERE id = ?`,
    [JSON.stringify(payload), at, row.id]
  );
  const updated = rowToBlock({ ...row, payload_json: JSON.stringify(payload), updated_at: at });
  publish(instance, updated);
  return updated;
}

// Returns blocks for a session in ordinal-ascending order. Used by the
// initial GET /api/chat/:id/blocks fetch and by the SSE handler when no
// Last-Event-ID is supplied.
export function listChatBlocks(instance: Instance, sessionId: string): ChatBlock[] {
  const db = getMemoryDb(instance);
  return db
    .query<ChatBlockRow, [string]>(
      "SELECT * FROM chat_blocks WHERE session_id = ? ORDER BY ordinal ASC"
    )
    .all(sessionId)
    .map(rowToBlock);
}

// Returns blocks added (or last-updated, for assistant_text and tool_call)
// AFTER the given Last-Event-ID cursor. Used by the SSE handler so a
// reconnecting client gets only what it missed. When the cursor row is
// not found in the table (rolled out / wrong session), returns the full
// list — best-effort recovery, mirroring the legacy eventStream
// ring-buffer behavior in src/http.ts.
//
// Cursor format: the SSE emitter writes `id: <block_id>:<ts>` where `ts`
// is the row's `updated_at` snapshot at emit time. On reconnect the
// client (react-native-sse or any compliant EventSource) round-trips
// that string as `Last-Event-ID`. Parsing it back gives us:
//   - `cursor_id`  — used to read the cursor row's current `ordinal`
//                     (so the >ordinal half of the resume filter keeps
//                     working for late-arriving insert-only kinds)
//   - `client_ts`  — the timestamp the client actually saw, NOT the
//                     row's current `updated_at`. This is what makes
//                     in-place mutations (assistant_text deltas,
//                     tool_call status flips) on the cursor row itself
//                     replay correctly — the row's updated_at moved
//                     forward while the client was offline, and the
//                     comparison must be against the older snapshot.
//
// Back-compat: an old client without the `:<ts>` suffix falls back to
// reading the cursor row's CURRENT `updated_at` as `client_ts`. Combined
// with the `>=` comparison below, this means the cursor row itself is
// still replayed with whatever payload it currently holds. The semantic
// gap vs. the suffixed path: if the cursor row was upserted between the
// snapshot the client saw and the resume, the bare-id client receives
// the latest payload (correct) but cannot prove which version it had.
// Earlier-ordinal in-place mutations that landed strictly before the
// fallback's `cutoff.updated_at` are not replayed — only the suffixed
// `<id>:<ts>` form preserves the client's actual snapshot timestamp.
//
// Resume filter: `(ordinal > cursor.ordinal OR updated_at >= client_ts)`.
// The `>=` handles same-ms ties — two events sharing an ISO timestamp
// would otherwise cause one to be skipped. The client's id-keyed upsert
// collapses any benign re-replay of the unchanged cursor row.
export function listChatBlocksAfter(
  instance: Instance,
  sessionId: string,
  afterBlockId: string | null
): ChatBlock[] {
  if (!afterBlockId) return listChatBlocks(instance, sessionId);
  // Parse the optional `:<ts>` suffix off the cursor. ISO timestamps
  // never contain `:` outside the time portion, so we split on the FIRST
  // `:` to separate the block id from the remainder; the block id format
  // (`block_<random>`) does not contain `:` either.
  const colonIdx = afterBlockId.indexOf(":");
  const cursorId =
    colonIdx === -1 ? afterBlockId : afterBlockId.slice(0, colonIdx);
  const clientTsFromCursor =
    colonIdx === -1 ? null : afterBlockId.slice(colonIdx + 1);

  const db = getMemoryDb(instance);
  const cutoff = db
    .query<{ ordinal: number; updated_at: string }, [string, string]>(
      "SELECT ordinal, updated_at FROM chat_blocks WHERE id = ? AND session_id = ?"
    )
    .get(cursorId, sessionId);
  if (!cutoff) {
    // Cursor is unknown to this session — replay everything we have.
    return listChatBlocks(instance, sessionId);
  }
  // If the client sent a snapshot timestamp, use it; otherwise (legacy
  // client) compare against the cursor row's CURRENT updated_at. With the
  // `>=` filter that follows, the cursor row still replays with its
  // current payload — but the fallback can't recover earlier-ordinal
  // in-place mutations that landed strictly before the cursor's current
  // updated_at, because no older snapshot is available.
  const clientTs = clientTsFromCursor ?? cutoff.updated_at;
  return db
    .query<ChatBlockRow, [string, number, string]>(
      `SELECT * FROM chat_blocks
       WHERE session_id = ?
         AND (ordinal > ? OR updated_at >= ?)
       ORDER BY ordinal ASC`
    )
    .all(sessionId, cutoff.ordinal, clientTs)
    .map(rowToBlock);
}

// Per-session most-recent message text. Returns a Map keyed by sessionId
// containing the latest user_text / assistant_text block's text (other
// block kinds are skipped — phase/tool_call/tool_result/etc. aren't
// "messages" in the conversational sense). Used by the chat list
// endpoint to populate a preview subtitle without N+1 queries.
//
// Uses a window function so we get the latest matching row per session
// in one SQL trip. Sessions with no qualifying blocks are omitted from
// the map (caller treats that as null).
export function getLatestMessagesBySession(
  instance: Instance
): Map<string, string> {
  const db = getMemoryDb(instance);
  const rows = db
    .query<{ session_id: string; payload_json: string }, [string]>(
      `SELECT session_id, payload_json FROM (
         SELECT session_id, payload_json, kind, ordinal,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ordinal DESC) AS rn
         FROM chat_blocks
         WHERE instance = ? AND kind IN ('user_text', 'assistant_text')
       ) WHERE rn = 1`
    )
    .all(instance);
  const map = new Map<string, string>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as { text?: string };
      if (typeof payload.text === "string" && payload.text.trim().length > 0) {
        map.set(row.session_id, payload.text);
      }
    } catch {
      // skip malformed rows — never block the chat list on a parse error
    }
  }
  return map;
}

// Cascade delete invoked by deleteChatSession in src/state/records.ts so
// stale block rows don't survive the session. Returns the number of rows
// removed so the caller can audit it; idempotent for sessions that never
// had blocks.
export function deleteChatBlocksForSession(
  instance: Instance,
  sessionId: string
): number {
  const db = getMemoryDb(instance);
  const result = db.run("DELETE FROM chat_blocks WHERE session_id = ?", [sessionId]);
  return result.changes ?? 0;
}

// Subscribe to a session's block stream. Returns an unsubscribe function;
// the SSE route in src/http.ts calls this on ReadableStream.cancel() so
// a closed connection doesn't accumulate dead listeners.
//
// Listeners are invoked AFTER the SQLite commit, so observers see only
// durable rows. Throwing handlers are caught and logged so a single
// buggy subscriber can't take down the emit fan-out.
export function subscribeChatBlocks(
  instance: Instance,
  sessionId: string,
  handler: (block: ChatBlock) => void
): () => void {
  const key = subscriptionKey(instance, sessionId);
  const wrapped = (block: ChatBlock): void => {
    try {
      handler(block);
    } catch (error) {
      // Best-effort logging — a thrown handler must not break the fan-out.
      console.warn(
        `[chat-blocks] subscriber for ${key} threw:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  };
  emitter.on(key, wrapped);
  return () => {
    emitter.off(key, wrapped);
  };
}

function publish(instance: Instance, block: ChatBlock): void {
  emitter.emit(subscriptionKey(instance, block.sessionId), block);
  // Fan out to instance-wide subscribers too — the APNs dispatcher
  // listens here so it sees every block for the instance without
  // having to enumerate sessions and re-subscribe as they spawn.
  emitter.emit(instanceKey(instance), block);
}

function instanceKey(instance: Instance): string {
  return `${instance}::*`;
}

// Subscribe to every block emitted on this instance, across all
// sessions. Returns an unsubscribe function. Used by long-lived
// observers (e.g. the APNs push dispatcher) that need a fan-out point
// independent of which session is active. Per-session SSE handlers
// continue to use subscribeChatBlocks(instance, sessionId, handler) so
// they only see their own traffic.
export function subscribeAllChatBlocks(
  instance: Instance,
  handler: (block: ChatBlock) => void
): () => void {
  const key = instanceKey(instance);
  const wrapped = (block: ChatBlock): void => {
    try {
      handler(block);
    } catch (error) {
      console.warn(
        `[chat-blocks] instance subscriber for ${key} threw:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  };
  emitter.on(key, wrapped);
  return () => {
    emitter.off(key, wrapped);
  };
}
