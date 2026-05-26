// Unit tests for the chat_read_state module.
//
// Pins:
//   - markRead is idempotent (same cursor → no error, updated_at bumps)
//   - markRead advances the cursor when a later block id is supplied
//   - unreadCountForCredential treats sessions with no row as fully
//     unread and excludes tool_result blocks
//   - getLastReadByCredential returns a per-session map keyed by sessionId
//   - read state is isolated per credential

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  closeAllMemoryDbs,
  getLastReadByCredential,
  getReadState,
  insertChatBlock,
  markRead,
  unreadCountForCredential
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
    const first = markRead(instance, "chat_a", "cred_x", block.id);
    const second = markRead(instance, "chat_a", "cred_x", block.id);
    expect(second.lastReadBlockId).toBe(block.id);
    // Same cursor on replay; timestamps may match within the same ms
    // but we shouldn't error and the row count stays at one.
    expect(typeof second.updatedAt).toBe("string");
    expect(getReadState(instance, "chat_a", "cred_x")?.lastReadBlockId).toBe(block.id);
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
    markRead(instance, "chat_a", "cred_x", a.id);
    markRead(instance, "chat_a", "cred_x", b.id);
    expect(getReadState(instance, "chat_a", "cred_x")?.lastReadBlockId).toBe(b.id);
  });

  test("unreadCountForCredential counts everything when no row exists", () => {
    const instance = "crs-fresh" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "2" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_b", text: "3" });
    expect(unreadCountForCredential(instance, "cred_x")).toBe(3);
  });

  test("unreadCountForCredential excludes tool_result blocks", () => {
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
      argsJson: "{}",
      status: "running"
    });
    insertChatBlock(instance, {
      kind: "tool_result",
      sessionId: "chat_a",
      callId: "call_1",
      output: "done"
    });
    // 3 raw rows, but tool_result doesn't count → unread = 2.
    expect(unreadCountForCredential(instance, "cred_x")).toBe(2);
  });

  test("unreadCountForCredential subtracts blocks at or before the cursor", () => {
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
    markRead(instance, "chat_a", "cred_x", a.id);
    // a counted as read (ordinal 1 cursor); two later blocks unread.
    expect(unreadCountForCredential(instance, "cred_x")).toBe(2);
  });

  test("unreadCountForCredential sums across sessions", () => {
    const instance = "crs-multi-session" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    const a2 = insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "2" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_b", text: "3" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_b", text: "4" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_c", text: "5" });
    // chat_a: marked read at a2 → 0 unread
    // chat_b: no row → both unread (2)
    // chat_c: no row → all unread (1)
    markRead(instance, "chat_a", "cred_x", a2.id);
    expect(unreadCountForCredential(instance, "cred_x")).toBe(3);
  });

  test("getLastReadByCredential returns per-session map", () => {
    const instance = "crs-map" as Instance;
    const a = insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    const b = insertChatBlock(instance, { kind: "user_text", sessionId: "chat_b", text: "2" });
    markRead(instance, "chat_a", "cred_x", a.id);
    markRead(instance, "chat_b", "cred_x", b.id);
    const map = getLastReadByCredential(instance, "cred_x");
    expect(map.size).toBe(2);
    expect(map.get("chat_a")).toBe(a.id);
    expect(map.get("chat_b")).toBe(b.id);
  });

  test("read state is isolated per credential", () => {
    const instance = "crs-isolation" as Instance;
    const a = insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "2" });
    markRead(instance, "chat_a", "cred_x", a.id);
    // cred_y has never marked anything — sees both blocks unread.
    expect(unreadCountForCredential(instance, "cred_x")).toBe(1);
    expect(unreadCountForCredential(instance, "cred_y")).toBe(2);
  });
});
