import { describe, expect, test } from "bun:test";
import { isOpenableJobChannel } from "./job-channel";
import type { ChatSession } from "./view-types";

function session(overrides: Partial<ChatSession>): ChatSession {
  return {
    id: "chat_1",
    instance: "test",
    title: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageIds: [],
    taskIds: [],
    runIds: [],
    ...overrides
  } as ChatSession;
}

describe("isOpenableJobChannel", () => {
  test("false for a missing session", () => {
    expect(isOpenableJobChannel(undefined)).toBe(false);
  });

  test("true when kind is channel", () => {
    expect(isOpenableJobChannel(session({ kind: "channel" }))).toBe(true);
  });

  test("true when origin is job even if kind is not yet backfilled", () => {
    // The drift this guards: a not-yet-normalized origin:"job" session has no
    // kind. The gateway counts it (origin:"job"), so the rail must show it too,
    // or the badge it feeds becomes undrainable on web.
    expect(isOpenableJobChannel(session({ origin: "job" }))).toBe(true);
  });

  test("true when both kind and origin mark it a channel", () => {
    expect(isOpenableJobChannel(session({ kind: "channel", origin: "job" }))).toBe(true);
  });

  test("false for a plain agent chat", () => {
    expect(isOpenableJobChannel(session({ kind: "agent" }))).toBe(false);
  });

  test("false for a bare session with neither marker", () => {
    expect(isOpenableJobChannel(session({}))).toBe(false);
  });

  test("archived channels are excluded even when kind/origin qualify", () => {
    expect(
      isOpenableJobChannel(session({ kind: "channel", origin: "job", archivedAt: "2026-01-02T00:00:00.000Z" }))
    ).toBe(false);
  });
});
