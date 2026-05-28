// Unit tests for the chat block persistence layer.
//
// Pins:
//   - ordinal allocation is per-session and monotonically increasing
//   - inserts and upserts fire the subscriber AFTER the SQLite commit
//   - assistant_text upserts replace text without changing ordinal
//   - tool_call upserts look up by callId + session and flip status
//   - listChatBlocksAfter respects the cursor, falls back to full list
//     when the cursor is unknown
//   - delete cascade clears the rows
//   - subscribers are isolated per (instance, sessionId)

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  closeAllMemoryDbs,
  deleteChatBlocksForSession,
  getMemoryDb,
  insertChatBlock,
  listChatBlocks,
  listChatBlocksAfter,
  subscribeChatBlocks,
  updateToolCallBlock,
  upsertAssistantTextBlock
} from "./index";
import type { ChatBlock } from "../types";

const ROOT = "/tmp/gini-chat-blocks-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  closeAllMemoryDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test uses its own instance name, but defensively reset the
  // module-level emitter listeners by closing the DB so nothing
  // accumulates across describe blocks if a previous failure left a
  // subscriber attached.
  closeAllMemoryDbs();
});

describe("chat-blocks persistence", () => {
  test("allocates ordinals per session in monotonic order", () => {
    const instance = "chat-blocks-ordinals";
    // Insert two blocks in session A and one in session B, interleaved.
    const a1 = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "hello"
    });
    const b1 = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_b",
      text: "ello"
    });
    const a2 = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_a",
      text: "Hi",
      streaming: true
    });
    const a3 = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_a",
      label: "Working: file_read"
    });

    expect(a1.ordinal).toBe(1);
    expect(a2.ordinal).toBe(2);
    expect(a3.ordinal).toBe(3);
    // Session B's ordinal stream is independent — also starts at 1.
    expect(b1.ordinal).toBe(1);

    const listed = listChatBlocks(instance, "chat_a");
    expect(listed.map((b) => b.ordinal)).toEqual([1, 2, 3]);
    expect(listed.map((b) => b.kind)).toEqual(["user_text", "assistant_text", "phase"]);
  });

  test("upsertAssistantTextBlock updates text without re-allocating ordinal", () => {
    const instance = "chat-blocks-assistant";
    const initial = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_x",
      text: "Hi",
      streaming: true
    });
    const after = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_x",
      label: "Completed"
    });
    expect(after.ordinal).toBe(2);

    const updated = upsertAssistantTextBlock(instance, initial.id, {
      text: "Hi there",
      streaming: true
    });
    expect(updated?.kind).toBe("assistant_text");
    if (updated?.kind === "assistant_text") {
      expect(updated.text).toBe("Hi there");
      expect(updated.streaming).toBe(true);
      expect(updated.ordinal).toBe(1);
    }

    // Final flip to streaming=false. Ordinal still pinned.
    const finalized = upsertAssistantTextBlock(instance, initial.id, {
      text: "Hi there, friend",
      streaming: false
    });
    expect(finalized?.kind).toBe("assistant_text");
    if (finalized?.kind === "assistant_text") {
      expect(finalized.text).toBe("Hi there, friend");
      expect(finalized.streaming).toBe(false);
      expect(finalized.ordinal).toBe(1);
    }
    // The phase block stays at ordinal 2 — order is preserved across the
    // upserts so a reconnecting client still sees text streaming before
    // the phase that followed.
    const listed = listChatBlocks(instance, "chat_x");
    expect(listed[0]?.ordinal).toBe(1);
    expect(listed[0]?.kind).toBe("assistant_text");
    expect(listed[1]?.ordinal).toBe(2);
    expect(listed[1]?.kind).toBe("phase");
  });

  test("updateToolCallBlock flips status by callId within session", () => {
    const instance = "chat-blocks-toolcall";
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_t",
      toolName: "file_read",
      displayLabel: "Read file",
      argsPreview: "hello.md",
      argsFull: { path: "hello.md" },
      status: "running",
      callId: "call_1"
    });
    // Parallel fan-out — two distinct callIds.
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_t",
      toolName: "file_list",
      displayLabel: "List files",
      argsPreview: ".",
      argsFull: { path: "." },
      status: "running",
      callId: "call_2"
    });

    const ok = updateToolCallBlock(instance, "call_1", "chat_t", { status: "ok" });
    expect(ok?.kind).toBe("tool_call");
    if (ok?.kind === "tool_call") expect(ok.status).toBe("ok");

    // Other call left untouched.
    const listed = listChatBlocks(instance, "chat_t");
    const call2 = listed.find(
      (b): b is ChatBlock & { kind: "tool_call" } =>
        b.kind === "tool_call" && b.callId === "call_2"
    );
    expect(call2?.status).toBe("running");

    // Error path stamps message.
    const err = updateToolCallBlock(instance, "call_2", "chat_t", {
      status: "error",
      errorMessage: "boom"
    });
    expect(err?.kind).toBe("tool_call");
    if (err?.kind === "tool_call") {
      expect(err.status).toBe("error");
      expect(err.errorMessage).toBe("boom");
    }
  });

  test("listChatBlocksAfter honors cursor and falls back when unknown", () => {
    const instance = "chat-blocks-cursor";
    const a = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_c",
      text: "hi"
    });
    const b = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_c",
      label: "Thinking"
    });
    const c = insertChatBlock(instance, {
      kind: "system_note",
      sessionId: "chat_c",
      text: "tick"
    });

    // Cursor format: `<id>:<ts>`. Use each block's createdAt as the
    // client snapshot — for insert-only kinds it equals updated_at.
    // The resume query returns blocks at-or-after the snapshot ordinal
    // *or* timestamp; the cursor itself replays via the >= comparison
    // (the mobile client's id-keyed upsert collapses it).
    const afterA = listChatBlocksAfter(
      instance,
      "chat_c",
      `${a.id}:${a.createdAt}`
    );
    expect(afterA.map((row) => row.id)).toEqual([a.id, b.id, c.id]);

    // Cursor pinned at the tail with a far-future timestamp: ordinal
    // branch never matches (no later rows) and the timestamp branch
    // never matches (all rows are older than the snapshot). Result is
    // empty. We pin an explicit timestamp rather than using c.createdAt
    // because the three inserts above land in the same millisecond, so
    // their updated_at strings tie and the >= comparison would include
    // every row.
    const afterTail = listChatBlocksAfter(
      instance,
      "chat_c",
      `${c.id}:2099-01-01T00:00:00.000Z`
    );
    expect(afterTail).toHaveLength(0);

    // Unknown cursor: best-effort fall back to the full session list.
    const afterUnknown = listChatBlocksAfter(
      instance,
      "chat_c",
      "block_does_not_exist:2099-01-01T00:00:00.000Z"
    );
    expect(afterUnknown.map((row) => row.id)).toEqual([a.id, b.id, c.id]);

    // Null cursor (initial subscribe): equivalent to listChatBlocks.
    const afterNull = listChatBlocksAfter(instance, "chat_c", null);
    expect(afterNull.map((row) => row.id)).toEqual([a.id, b.id, c.id]);

    // Legacy client (no `:<ts>` suffix): falls back to comparing against
    // the cursor row's current updated_at. Same `>=` semantics so the
    // cursor still replays, but in-place updates to the cursor row
    // itself are missed — kept for back-compat with shipped clients.
    const afterALegacy = listChatBlocksAfter(instance, "chat_c", a.id);
    expect(afterALegacy.map((row) => row.id)).toEqual([a.id, b.id, c.id]);
  });

  test("listChatBlocksAfter bare-id fallback uses the cursor row's current updated_at", () => {
    // Pins the back-compat path: an old client without the `:<ts>`
    // suffix on its Last-Event-ID. The fallback reads the cursor row's
    // CURRENT `updated_at` as `client_ts`, then applies the same
    // `(ordinal > cursor.ordinal OR updated_at >= client_ts)` filter.
    //
    // What this test proves (i.e. what a regression must NOT break):
    //   1. A bare id (no suffix) is parsed without throwing.
    //   2. The cursor row replays with its CURRENT payload — even though
    //      that payload was upserted between insert and resume.
    //   3. Earlier-ordinal rows whose updated_at is older than the
    //      cursor's current updated_at are NOT replayed (the fallback
    //      has no way to recover them — only the suffixed cursor form
    //      preserves the client's snapshot ts).
    const instance = "chat-blocks-legacy-fallback";
    // A: an assistant_text we'll upsert later, advancing its updated_at.
    const a = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_l",
      text: "Hi",
      streaming: true
    });
    // B: a later-ordinal phase. Force B's updated_at to a known-old
    // timestamp so we can prove the fallback's `>=` comparison excludes
    // it via the timestamp branch while the ordinal branch still picks
    // it up.
    const b = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_l",
      label: "Thinking"
    });
    const db = getMemoryDb(instance);
    const tsOld = "2000-01-01T00:00:00.000Z";
    db.run("UPDATE chat_blocks SET updated_at = ? WHERE id = ?", [tsOld, b.id]);

    // Mutate A in place. `upsertAssistantTextBlock` stamps a fresh
    // `updated_at` via `now()`, which is much newer than tsOld.
    const upserted = upsertAssistantTextBlock(instance, a.id, {
      text: "Hi there, friend",
      streaming: false
    });
    expect(upserted?.kind).toBe("assistant_text");

    // Resume with the BARE id of A (no `:<ts>` suffix). The fallback
    // reads A's current updated_at as the cutoff.
    const replay = listChatBlocksAfter(instance, "chat_l", a.id);
    const ids = replay.map((row) => row.id);
    // A replays via the `updated_at >= cutoff.updated_at` branch
    // (it's the same row — equal updated_at).
    expect(ids).toContain(a.id);
    // B replays via the `ordinal > cursor.ordinal` branch even though
    // its updated_at is older than the cutoff. This proves both halves
    // of the WHERE clause survive the bare-id path.
    expect(ids).toContain(b.id);

    // The cursor row's payload that replays is the UPSERTED text, not
    // the pre-upsert text — proves we read the current row, not a
    // cached snapshot.
    const replayedA = replay.find((row) => row.id === a.id);
    if (replayedA?.kind === "assistant_text") {
      expect(replayedA.text).toBe("Hi there, friend");
      expect(replayedA.streaming).toBe(false);
    }
  });

  test("listChatBlocksAfter replays in-place updates after the cursor", () => {
    // A reconnecting client carries a Last-Event-ID equal to the wire
    // event id the SSE emitter sent: `<block_id>:<updated_at_snapshot>`.
    // The resume query splits the cursor, looks up the row by id, then
    // returns every row whose ordinal moved past the cursor OR whose
    // updated_at is at-or-after the client snapshot. This lets in-place
    // upserts to the cursor row itself (assistant_text delta on the
    // in-flight reply, tool_call status flip) replay on reconnect.
    const instance = "chat-blocks-resume-upserts";
    const stream = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_r",
      text: "Hi",
      streaming: true
    });
    const streamTsOld =
      stream.kind === "assistant_text" ? stream.updatedAt : stream.createdAt;
    const call = insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_r",
      toolName: "file_read",
      displayLabel: "Read file",
      argsPreview: "x.md",
      argsFull: { path: "x.md" },
      status: "running",
      callId: "call_resume"
    });
    const phase = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_r",
      label: "Working: file_read"
    });

    // Tool_call flips to ok in place — its updated_at moves forward.
    updateToolCallBlock(instance, "call_resume", "chat_r", { status: "ok" });

    // Resume from cursor=stream.id with the old ts snapshot. The cursor
    // row itself replays via the same-ms tie (updated_at >= streamTsOld);
    // the tool_call (ordinal 2) and phase (3) replay via the ordinal
    // branch. The mobile client's id-keyed upsert collapses any
    // re-replay of the unchanged cursor row.
    const replay = listChatBlocksAfter(
      instance,
      "chat_r",
      `${stream.id}:${streamTsOld}`
    );
    const replayedIds = replay.map((row) => row.id).sort();
    expect(replayedIds).toEqual([stream.id, call.id, phase.id].sort());

    const replayedCall = replay.find((row) => row.id === call.id);
    if (replayedCall?.kind === "tool_call") {
      expect(replayedCall.status).toBe("ok");
    }

    // Same shape for assistant_text deltas to an earlier-ordinal block.
    upsertAssistantTextBlock(instance, stream.id, {
      text: "Hi there",
      streaming: false
    });
    // New cursor = phase.id (latest ordinal) at phase's createdAt.
    // Earlier-ordinal blocks with newer updated_at must replay — both
    // the assistant_text upsert we just did and the still-newer tool_call
    // ok flip from earlier.
    const replay2 = listChatBlocksAfter(
      instance,
      "chat_r",
      `${phase.id}:${phase.createdAt}`
    );
    const ids2 = replay2.map((row) => row.id).sort();
    // Phase itself is included via the updated_at >= clientTs branch
    // (same-ms tie). Both upserted rows replay.
    expect(ids2).toEqual([stream.id, call.id, phase.id].sort());
    const text = replay2.find((row) => row.id === stream.id);
    if (text?.kind === "assistant_text") {
      expect(text.text).toBe("Hi there");
      expect(text.streaming).toBe(false);
    }
  });

  test("listChatBlocksAfter replays the cursor block when it was upserted in place", () => {
    // The canonical streaming case: cursor is the in-flight assistant_text
    // block, and while the client was offline the row was upserted with
    // new text (and eventually streaming:false). With the richer cursor
    // (`<id>:<ts_old>`) the row's current updated_at is > ts_old, so the
    // resume query returns the upserted block.
    //
    // The wire-format invariant we pin: the upserted text is what the
    // resuming client sees on the cursor row (not the pre-upsert text).
    // We deterministically pin timestamps via direct UPDATEs so the test
    // doesn't ride on `Date.now()` resolution.
    const instance = "chat-blocks-resume-cursor-self";
    const stream = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_s",
      text: "Hi",
      streaming: true
    });

    // Force the row's updated_at to a known pre-upsert snapshot. We
    // pick a deliberately old timestamp so the in-place upsert below
    // (stamped with `now()`) lands strictly after it — regardless of
    // the system clock or per-test scheduling jitter.
    const tsOld = "2000-01-01T00:00:00.000Z";
    const db = getMemoryDb(instance);
    db.run("UPDATE chat_blocks SET updated_at = ? WHERE id = ?", [
      tsOld,
      stream.id
    ]);

    // In-place upsert. `upsertAssistantTextBlock` stamps updated_at via
    // `now()`, which will be much later than tsOld.
    const upserted = upsertAssistantTextBlock(instance, stream.id, {
      text: "Hi there, friend",
      streaming: false
    });
    expect(upserted?.kind).toBe("assistant_text");

    const replay = listChatBlocksAfter(
      instance,
      "chat_s",
      `${stream.id}:${tsOld}`
    );
    const replayedStream = replay.find((row) => row.id === stream.id);
    expect(replayedStream).toBeDefined();
    if (replayedStream?.kind === "assistant_text") {
      expect(replayedStream.text).toBe("Hi there, friend");
      expect(replayedStream.streaming).toBe(false);
    }
  });

  test("listChatBlocksAfter replays same-ms ties via >= comparison", () => {
    // Pins the `>=` half of the resume filter independently of the
    // `ordinal >` half. A regression to strict `>` on the timestamp
    // branch must be caught here.
    //
    // Construction: A (ordinal=1) and B (ordinal=2). Cursor is B at
    // timestamp `tiedAt`. We then force A's `updated_at` to equal
    // `tiedAt` — modeling the realistic case where an earlier-ordinal
    // row was upserted in the same millisecond as the cursor row was
    // snapshotted. With cursor=B, the `ordinal > 2` branch CANNOT match
    // A (A.ordinal=1), so the only way A appears in the replay is via
    // `updated_at >= tiedAt`. A strict `>` would drop A.
    const instance = "chat-blocks-resume-tie";
    const a = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_t",
      text: "a"
    });
    const b = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_t",
      label: "Thinking"
    });
    const tiedAt = "2099-01-01T00:00:00.000Z";
    const db = getMemoryDb(instance);
    db.run(
      "UPDATE chat_blocks SET updated_at = ? WHERE session_id = ? AND id IN (?, ?)",
      [tiedAt, "chat_t", a.id, b.id]
    );

    // Cursor pins B at tiedAt. A has a LOWER ordinal than the cursor —
    // the only branch that can surface A is `updated_at >= tiedAt`.
    const replay = listChatBlocksAfter(
      instance,
      "chat_t",
      `${b.id}:${tiedAt}`
    );
    const ids = replay.map((row) => row.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  test("subscribers fire on insert and upsert, then stop after unsubscribe", () => {
    const instance = "chat-blocks-subscribe";
    const events: ChatBlock[] = [];
    const unsubscribe = subscribeChatBlocks(instance, "chat_sub", (block) => {
      events.push(block);
    });

    const first = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_sub",
      text: "first"
    });
    const stream = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_sub",
      text: "",
      streaming: true
    });
    upsertAssistantTextBlock(instance, stream.id, { text: "ok", streaming: true });
    upsertAssistantTextBlock(instance, stream.id, { text: "ok!", streaming: false });

    expect(events).toHaveLength(4);
    expect(events[0]?.id).toBe(first.id);
    expect(events[1]?.kind).toBe("assistant_text");
    expect(events[2]?.kind).toBe("assistant_text");
    if (events[2]?.kind === "assistant_text") expect(events[2].text).toBe("ok");
    if (events[3]?.kind === "assistant_text") {
      expect(events[3].text).toBe("ok!");
      expect(events[3].streaming).toBe(false);
    }

    unsubscribe();
    insertChatBlock(instance, {
      kind: "system_note",
      sessionId: "chat_sub",
      text: "after unsubscribe"
    });
    expect(events).toHaveLength(4);
  });

  test("subscribers are isolated per (instance, sessionId)", () => {
    const instance = "chat-blocks-isolation";
    const aEvents: ChatBlock[] = [];
    const bEvents: ChatBlock[] = [];
    const unsubA = subscribeChatBlocks(instance, "chat_a", (block) => aEvents.push(block));
    const unsubB = subscribeChatBlocks(instance, "chat_b", (block) => bEvents.push(block));

    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "a"
    });
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_b",
      text: "b"
    });

    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(1);
    if (aEvents[0]?.kind === "user_text") expect(aEvents[0].text).toBe("a");
    if (bEvents[0]?.kind === "user_text") expect(bEvents[0].text).toBe("b");

    unsubA();
    unsubB();
  });

  test("deleteChatBlocksForSession removes only that session's rows", () => {
    const instance = "chat-blocks-delete";
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_d1", text: "1" });
    insertChatBlock(instance, { kind: "phase", sessionId: "chat_d1", label: "x" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_d2", text: "2" });

    expect(deleteChatBlocksForSession(instance, "chat_d1")).toBe(2);
    expect(listChatBlocks(instance, "chat_d1")).toHaveLength(0);
    expect(listChatBlocks(instance, "chat_d2")).toHaveLength(1);

    // Idempotent: second delete returns zero, listChatBlocks still empty.
    expect(deleteChatBlocksForSession(instance, "chat_d1")).toBe(0);
  });

  test("rows persist taskId, runId, and agentId for indexable joins", () => {
    const instance = "chat-blocks-metadata";
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_meta",
      toolName: "file_read",
      displayLabel: "Read file",
      argsPreview: "hello.md",
      argsFull: { path: "hello.md" },
      status: "running",
      callId: "call_meta",
      taskId: "task_meta",
      runId: "run_meta",
      agentId: "agent_meta"
    });

    // Verify the columns are persisted (we expose them via the
    // re-assembled block + the agent_id column directly on the row).
    const block = listChatBlocks(instance, "chat_meta")[0];
    expect(block?.taskId).toBe("task_meta");
    expect(block?.runId).toBe("run_meta");

    const db = getMemoryDb(instance);
    const row = db
      .query<{ agent_id: string | null; task_id: string | null; run_id: string | null }, [string]>(
        "SELECT agent_id, task_id, run_id FROM chat_blocks WHERE id = ?"
      )
      .get(block!.id);
    expect(row?.agent_id).toBe("agent_meta");
    expect(row?.task_id).toBe("task_meta");
    expect(row?.run_id).toBe("run_meta");
  });
});
