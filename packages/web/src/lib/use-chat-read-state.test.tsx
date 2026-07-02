/// <reference lib="dom" />

// Unread read-state tests. Pins the contract that a chat channel's unread
// signal tracks DELIVERED assistant replies only — never mid-run progress
// (tool calls, streaming, dispatch, subagent runs completing one-by-one).
// A run carries `assistantMessageId` exactly when its final answer is
// persisted as a durable chat message, with `run.updatedAt` stamped to that
// message's createdAt; only those runs may advance the timestamp. This is the
// regression guard for job channels re-flagging unread on every tool call
// while the job is still working.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatSession } from "@/lib/view-types";
import { useChatReadState } from "./use-chat-read-state";

const T = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

// Build a minimal session shaped like the list endpoint's enrichment: the
// runtime narrows to { id, createdAt, updatedAt, runs, origin } internally,
// so the extra ChatSessionRecord fields the type wants aren't read here.
function makeSession(
  overrides: {
    id?: string;
    createdAt?: string;
    updatedAt?: string;
    origin?: "job";
    runs?: Array<{ updatedAt: string; assistantMessageId?: string }>;
  } = {}
): ChatSession {
  return {
    id: "chat_1",
    createdAt: T(0),
    updatedAt: T(0),
    runs: [],
    ...overrides
  } as unknown as ChatSession;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("activityAt", () => {
  test("ignores session.updatedAt — dispatch/run-creation bumps don't count", () => {
    const { result } = renderHook(() => useChatReadState([]));
    // Job dispatched: session.updatedAt jumped to T(5) but no reply landed yet.
    const session = makeSession({ updatedAt: T(5), runs: [] });
    expect(result.current.activityAt(session)).toBe(T(0));
  });

  test("ignores runs that haven't delivered a reply (in-flight / subagent runs)", () => {
    const { result } = renderHook(() => useChatReadState([]));
    // A run is mid-flight and a subagent child run just completed — both advance
    // run.updatedAt, but neither carries an assistantMessageId, so the channel
    // has produced no final reply.
    const session = makeSession({
      updatedAt: T(7),
      runs: [{ updatedAt: T(6) }, { updatedAt: T(7) }]
    });
    expect(result.current.activityAt(session)).toBe(T(0));
  });

  test("advances to the latest delivered reply", () => {
    const { result } = renderHook(() => useChatReadState([]));
    const session = makeSession({
      updatedAt: T(9),
      runs: [
        { updatedAt: T(4), assistantMessageId: "msg_1" },
        { updatedAt: T(8), assistantMessageId: "msg_2" },
        // Newer mid-run activity that hasn't delivered — must not win.
        { updatedAt: T(9) }
      ]
    });
    expect(result.current.activityAt(session)).toBe(T(8));
  });
});

describe("isUnread for a running job channel", () => {
  test("stays read while running, re-flags only when the reply lands", () => {
    const id = "chat_job";
    // First load: one delivered reply at T(4). Job channels aren't seeded, so
    // it surfaces unread until opened.
    let sessions = [
      makeSession({ id, origin: "job", runs: [{ updatedAt: T(4), assistantMessageId: "msg_1" }] })
    ];
    const { result, rerender } = renderHook((s: ChatSession[]) => useChatReadState(s), {
      initialProps: sessions
    });
    expect(result.current.isUnread(sessions[0])).toBe(true);

    // User opens the channel.
    act(() => result.current.markRead(sessions[0]));
    expect(result.current.isUnread(sessions[0])).toBe(false);

    // Next tick runs: session.updatedAt bumps and a subagent run completes
    // mid-flight, but no new reply has been delivered. Must stay read.
    sessions = [
      makeSession({
        id,
        origin: "job",
        updatedAt: T(7),
        runs: [
          { updatedAt: T(4), assistantMessageId: "msg_1" },
          { updatedAt: T(6) },
          { updatedAt: T(7) }
        ]
      })
    ];
    rerender(sessions);
    expect(result.current.isUnread(sessions[0])).toBe(false);

    // The run finally delivers its reply — now it should re-flag unread.
    sessions = [
      makeSession({
        id,
        origin: "job",
        updatedAt: T(8),
        runs: [
          { updatedAt: T(4), assistantMessageId: "msg_1" },
          { updatedAt: T(8), assistantMessageId: "msg_2" }
        ]
      })
    ];
    rerender(sessions);
    expect(result.current.isUnread(sessions[0])).toBe(true);
  });
});
