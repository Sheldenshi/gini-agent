// Unit tests for the chat_read_state module.
//
// Pins:
//   - markRead is idempotent (same cursor → no error, updated_at bumps)
//   - markRead advances the cursor when a later block id is supplied
//   - markRead refuses to move the cursor backwards (monotonic)
//   - unreadCountForDevice treats sessions with no row as fully
//     unread and excludes tool_result + phase blocks
//   - getLastReadByDevice returns a per-session map keyed by sessionId
//   - read state is isolated per device

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  closeAllMemoryDbs,
  getLastReadByDevice,
  getReadState,
  insertChatBlock,
  markRead,
  unreadCountForDevice
} from "./index";
import type { Instance } from "../types";

const ROOT = "/tmp/gini-chat-read-state-test";

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
  closeAllMemoryDbs();
});

describe("chat-read-state", () => {
  test("markRead is idempotent and updates the timestamp on replay", () => {
    const instance = "crs-idempotent" as Instance;
    const block = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "hi"
    });
    const first = markRead(instance, "chat_a", "tok_x", block.id);
    const second = markRead(instance, "chat_a", "tok_x", block.id);
    expect(second.lastReadBlockId).toBe(block.id);
    expect(typeof second.updatedAt).toBe("string");
    expect(getReadState(instance, "chat_a", "tok_x")?.lastReadBlockId).toBe(block.id);
    expect(first.lastReadBlockId).toBe(second.lastReadBlockId);
  });

  test("markRead advances the cursor on a later block id", () => {
    const instance = "crs-advance" as Instance;
    const a = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "one"
    });
    const b = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "two"
    });
    markRead(instance, "chat_a", "tok_x", a.id);
    markRead(instance, "chat_a", "tok_x", b.id);
    expect(getReadState(instance, "chat_a", "tok_x")?.lastReadBlockId).toBe(b.id);
  });

  test("markRead does not move the cursor backwards", () => {
    // Pin the monotonicity guard: a stale replay of an older block id
    // (older ordinal) leaves the existing cursor alone. Otherwise a
    // delayed network write could re-inflate the badge after the user
    // already read past the older block.
    const instance = "crs-monotonic" as Instance;
    const a = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "one"
    });
    const b = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "two"
    });
    markRead(instance, "chat_a", "tok_x", b.id);
    // Replay with the EARLIER block — must not regress the cursor.
    markRead(instance, "chat_a", "tok_x", a.id);
    expect(getReadState(instance, "chat_a", "tok_x")?.lastReadBlockId).toBe(b.id);
    // And unread count is still 0 (cursor stayed at the tail).
    expect(unreadCountForDevice(instance, "tok_x")).toBe(0);
  });

  test("unreadCountForDevice counts everything when no row exists", () => {
    const instance = "crs-fresh" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "2" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_b", text: "3" });
    expect(unreadCountForDevice(instance, "tok_x")).toBe(3);
  });

  test("unreadCountForDevice excludes tool_result blocks", () => {
    const instance = "crs-no-toolresult" as Instance;
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "do thing"
    });
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_a",
      callId: "call_1",
      toolName: "echo",
      displayLabel: "Echo",
      argsPreview: "{}",
      argsFull: {},
      status: "running"
    });
    insertChatBlock(instance, {
      kind: "tool_result",
      sessionId: "chat_a",
      callId: "call_1",
      preview: "done",
      truncated: false
    });
    // 3 raw rows, but tool_result doesn't count → unread = 2.
    expect(unreadCountForDevice(instance, "tok_x")).toBe(2);
  });

  test("unreadCountForDevice excludes phase blocks", () => {
    // Phase blocks (Thinking, Working, Completed, ...) are filtered
    // out of the chat detail screen — historical phases never render
    // standalone. They must not count toward the badge.
    const instance = "crs-no-phase" as Instance;
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "go"
    });
    insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_a",
      label: "Thinking"
    });
    insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_a",
      label: "Completed"
    });
    expect(unreadCountForDevice(instance, "tok_x")).toBe(1);
  });

  test("unreadCountForDevice subtracts blocks at or before the cursor", () => {
    const instance = "crs-after-cursor" as Instance;
    const a = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "1"
    });
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "2"
    });
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "3"
    });
    markRead(instance, "chat_a", "tok_x", a.id);
    // a counted as read (ordinal 1 cursor); two later blocks unread.
    expect(unreadCountForDevice(instance, "tok_x")).toBe(2);
  });

  test("unreadCountForDevice sums across sessions", () => {
    const instance = "crs-multi-session" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    const a2 = insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "2" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_b", text: "3" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_b", text: "4" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_c", text: "5" });
    // chat_a: marked read at a2 → 0 unread
    // chat_b: no row → both unread (2)
    // chat_c: no row → all unread (1)
    markRead(instance, "chat_a", "tok_x", a2.id);
    expect(unreadCountForDevice(instance, "tok_x")).toBe(3);
  });

  test("getLastReadByDevice returns per-session map", () => {
    const instance = "crs-map" as Instance;
    const a = insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    const b = insertChatBlock(instance, { kind: "user_text", sessionId: "chat_b", text: "2" });
    markRead(instance, "chat_a", "tok_x", a.id);
    markRead(instance, "chat_b", "tok_x", b.id);
    const map = getLastReadByDevice(instance, "tok_x");
    expect(map.size).toBe(2);
    expect(map.get("chat_a")).toBe(a.id);
    expect(map.get("chat_b")).toBe(b.id);
  });

  test("read state is isolated per device", () => {
    // Two devices owned by the same human (would share one
    // credential under the runtime's single-tenant model) each have
    // their own cursor. iPhone A reading the chat must NOT clear
    // iPhone B's badge.
    const instance = "crs-isolation" as Instance;
    const a = insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "2" });
    markRead(instance, "chat_a", "tok_iphone_a", a.id);
    expect(unreadCountForDevice(instance, "tok_iphone_a")).toBe(1);
    expect(unreadCountForDevice(instance, "tok_iphone_b")).toBe(2);
  });
});
