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
  clearReadState,
  closeAllMemoryDbs,
  getLastReadByDevice,
  getReadState,
  insertChatBlock,
  markRead,
  markUnread,
  unreadCountForDevice,
  unreadCountsByDevice
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

  test("unreadCountsByDevice groups unread blocks per session and omits zeros", () => {
    const instance = "crs-counts-by-session" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    const a2 = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "2"
    });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_b", text: "3" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_b", text: "4" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_c", text: "5" });
    // Fresh device, no read cursor anywhere — every session reports its
    // visible block count.
    const fresh = unreadCountsByDevice(instance, "tok_fresh");
    expect(fresh.get("chat_a")).toBe(2);
    expect(fresh.get("chat_b")).toBe(2);
    expect(fresh.get("chat_c")).toBe(1);

    // Catch up on chat_a — it drops out of the map (zero counts omitted).
    markRead(instance, "chat_a", "tok_fresh", a2.id);
    const after = unreadCountsByDevice(instance, "tok_fresh");
    expect(after.has("chat_a")).toBe(false);
    expect(after.get("chat_b")).toBe(2);
    expect(after.get("chat_c")).toBe(1);

    // Sum equals the cross-session total.
    const total = unreadCountForDevice(instance, "tok_fresh");
    let sum = 0;
    for (const n of after.values()) sum += n;
    expect(sum).toBe(total);
  });

  test("unreadCountsByDevice is per-device, like the aggregate", () => {
    const instance = "crs-counts-isolation" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    const a = unreadCountsByDevice(instance, "tok_iphone_a");
    const b = unreadCountsByDevice(instance, "tok_iphone_b");
    expect(a.get("chat_a")).toBe(1);
    expect(b.get("chat_a")).toBe(1);
    // Clear A's row by marking read; B's count stays put.
    markRead(
      instance,
      "chat_a",
      "tok_iphone_a",
      insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "2" }).id
    );
    expect(unreadCountsByDevice(instance, "tok_iphone_a").has("chat_a")).toBe(false);
    expect(unreadCountsByDevice(instance, "tok_iphone_b").get("chat_a")).toBe(2);
  });

  test("unreadCountForDevice excludes blocks from excluded session ids", () => {
    // The regression this pins: a session the user can't reach (an
    // archived job channel) must not contribute to the badge, since
    // there's no way to open it and clear the read-state. The aggregate
    // counts everything by default; passing the session id in
    // excludeSessionIds zeroes its contribution.
    const instance = "crs-exclude-aggregate" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_reachable", text: "1" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_archived", text: "2" });
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_archived",
      callId: "call_1",
      toolName: "echo",
      displayLabel: "Echo",
      argsPreview: "{}",
      argsFull: {},
      status: "running"
    });
    // No read cursor anywhere — without exclusion every visible block counts.
    expect(unreadCountForDevice(instance, "tok_x")).toBe(3);
    // Excluding the archived session drops its two blocks.
    expect(unreadCountForDevice(instance, "tok_x", ["chat_archived"])).toBe(1);
    // An empty exclusion list is identical to omitting the argument.
    expect(unreadCountForDevice(instance, "tok_x", [])).toBe(3);
  });

  test("unreadCountForDevice excludes multiple session ids at once", () => {
    const instance = "crs-exclude-many" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_b", text: "2" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_c", text: "3" });
    expect(unreadCountForDevice(instance, "tok_x", ["chat_a", "chat_b"])).toBe(1);
    // An exclusion id that matches no session is a harmless no-op.
    expect(unreadCountForDevice(instance, "tok_x", ["chat_missing"])).toBe(3);
  });

  test("unreadCountsByDevice omits excluded sessions from the per-row map", () => {
    const instance = "crs-exclude-by-session" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_archived", text: "2" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_archived", text: "3" });
    const counts = unreadCountsByDevice(instance, "tok_x", ["chat_archived"]);
    expect(counts.get("chat_a")).toBe(1);
    expect(counts.has("chat_archived")).toBe(false);
    // The per-row map and the aggregate agree on the reachable total.
    let sum = 0;
    for (const n of counts.values()) sum += n;
    expect(sum).toBe(unreadCountForDevice(instance, "tok_x", ["chat_archived"]));
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

  test("clearReadState drops the row and re-inflates the badge", () => {
    const instance = "crs-clear" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    const b = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "2"
    });
    markRead(instance, "chat_a", "tok_x", b.id);
    expect(unreadCountForDevice(instance, "tok_x")).toBe(0);
    clearReadState(instance, "chat_a", "tok_x");
    expect(getReadState(instance, "chat_a", "tok_x")).toBeNull();
    expect(unreadCountForDevice(instance, "tok_x")).toBe(2);
  });

  test("clearReadState is idempotent on a missing row", () => {
    const instance = "crs-clear-missing" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "1" });
    expect(() => clearReadState(instance, "chat_a", "tok_x")).not.toThrow();
    expect(getReadState(instance, "chat_a", "tok_x")).toBeNull();
  });

  test("markUnread pins cursor to before the latest assistant_text (count = 1)", () => {
    const instance = "crs-mark-unread" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "hi" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "still hi" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "ping?" });
    const assistant = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_a",
      text: "hello back",
      streaming: false
    });
    markRead(instance, "chat_a", "tok_x", assistant.id);
    expect(unreadCountForDevice(instance, "tok_x")).toBe(0);
    markUnread(instance, "chat_a", "tok_x");
    expect(unreadCountForDevice(instance, "tok_x")).toBe(1);
    // Idempotent — replaying lands on the same cursor and stays at 1.
    markUnread(instance, "chat_a", "tok_x");
    expect(unreadCountForDevice(instance, "tok_x")).toBe(1);
  });

  test("markUnread counts trailing tool_calls along with the latest assistant turn", () => {
    const instance = "crs-mark-unread-tools" as Instance;
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "go" });
    insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_a",
      text: "on it",
      streaming: false
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
    markUnread(instance, "chat_a", "tok_x");
    expect(unreadCountForDevice(instance, "tok_x")).toBe(2);
  });

  test("markUnread falls back to clearing the cursor when there is no assistant_text", () => {
    const instance = "crs-mark-unread-no-assistant" as Instance;
    const a = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "hi"
    });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_a", text: "hi again" });
    markRead(instance, "chat_a", "tok_x", a.id);
    markUnread(instance, "chat_a", "tok_x");
    expect(getReadState(instance, "chat_a", "tok_x")).toBeNull();
    expect(unreadCountForDevice(instance, "tok_x")).toBe(2);
  });

  test("markUnread clears the cursor when assistant_text is the only visible block", () => {
    const instance = "crs-mark-unread-only-assistant" as Instance;
    const assistant = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_a",
      text: "hello",
      streaming: false
    });
    markRead(instance, "chat_a", "tok_x", assistant.id);
    markUnread(instance, "chat_a", "tok_x");
    expect(getReadState(instance, "chat_a", "tok_x")).toBeNull();
    expect(unreadCountForDevice(instance, "tok_x")).toBe(1);
  });

  test("clearReadState only clears the caller's device", () => {
    const instance = "crs-clear-isolation" as Instance;
    const a = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "1"
    });
    markRead(instance, "chat_a", "tok_iphone_a", a.id);
    markRead(instance, "chat_a", "tok_iphone_b", a.id);
    clearReadState(instance, "chat_a", "tok_iphone_a");
    expect(getReadState(instance, "chat_a", "tok_iphone_a")).toBeNull();
    expect(getReadState(instance, "chat_a", "tok_iphone_b")?.lastReadBlockId).toBe(a.id);
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
