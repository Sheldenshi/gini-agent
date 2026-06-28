// Tests for createTopic (ADR chat-topics-tasks-subagents.md).
//
// Pins that a Topic is a kind:"topic" chat session that reuses the
// chat-session machinery: it carries the given title and parentChatSessionId,
// honors an optional origin, and emits the same chat.session.created event the
// other session constructors do (so SSE / inbox attribution still fire).
//
// Hermetic: an in-memory state from createEmptyState (no disk I/O), but the
// env root is scoped to this slice so parallel files can't collide.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createEmptyState } from "./store";
import { createTopic } from "./records";

const ROOT = "/tmp/gini-records-create-topic-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("createTopic", () => {
  test("creates a kind:'topic' session with title, parent, and origin, and appends chat.session.created", () => {
    const state = createEmptyState("topic-create");
    const topic = createTopic(state, {
      agentId: "agent_a",
      title: "World cup trip with dad",
      parentChatSessionId: "chat_parent",
      origin: "job"
    });

    expect(topic.kind).toBe("topic");
    expect(topic.agentId).toBe("agent_a");
    expect(topic.title).toBe("World cup trip with dad");
    expect(topic.parentChatSessionId).toBe("chat_parent");
    expect(topic.origin).toBe("job");

    // The session is registered in state and the created event fired.
    expect(state.chatSessions.find((s) => s.id === topic.id)).toBeDefined();
    const created = state.events.find(
      (e) => e.target === topic.id && e.action === "chat.session.created"
    );
    expect(created).toBeDefined();
  });

  test("omits parentChatSessionId when not supplied", () => {
    const state = createEmptyState("topic-no-parent");
    const topic = createTopic(state, { title: "Standalone topic" });

    expect(topic.kind).toBe("topic");
    expect(topic.title).toBe("Standalone topic");
    expect(topic.parentChatSessionId).toBeUndefined();
    expect(topic.origin).toBeUndefined();
  });
});
