// Tests for the canonical agent-chat resolver (getOrCreateAgentChat).
//
// Pins:
//   - returns a stable single session across repeated calls
//   - creates a kind:"agent" session when the agent has none
//   - promotes the most-recent non-job, non-bridge session to kind:"agent"
//   - prefers a canonical chat with history over an empty duplicate, and
//     demotes the empty one so a single canonical chat remains
//   - never returns a job (channel) or messaging-bridge session
//
// The resolver must be called with a real AgentRecord id: normalizeState's
// migrateRecordAgentIds re-stamps any chatSession whose agentId points at a
// non-existent agent, so each test registers its agents in state.agents
// first.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createChatSession, mutateState, now, readState } from "../state";
import { defaultAgent } from "../state/defaults";
import { getOrCreateAgentChat } from "./chat";
import type { AgentRecord, Instance } from "../types";

const ROOT = "/tmp/gini-agent-chat-resolver-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// Registers an additional AgentRecord so normalizeState treats its id as
// valid and leaves sessions stamped with it alone.
async function registerAgent(instance: Instance, agentId: string): Promise<void> {
  await mutateState(instance, (state) => {
    if (state.agents.some((a) => a.id === agentId)) return;
    const agent: AgentRecord = { ...defaultAgent(instance, now()), id: agentId, name: agentId, status: "inactive" };
    state.agents.push(agent);
  });
}

describe("getOrCreateAgentChat", () => {
  test("creates a kind:'agent' session when the agent has none, then returns it stably", async () => {
    const instance = "agent-chat-create";
    await registerAgent(instance, "agent_a");
    const first = await getOrCreateAgentChat(instance, "agent_a");
    expect(first.kind).toBe("agent");
    expect(first.agentId).toBe("agent_a");

    const second = await getOrCreateAgentChat(instance, "agent_a");
    expect(second.id).toBe(first.id);

    // Exactly one canonical chat exists for the agent.
    const state = readState(instance);
    const canonical = state.chatSessions.filter(
      (s) => s.agentId === "agent_a" && s.kind === "agent"
    );
    expect(canonical).toHaveLength(1);
  });

  test("promotes the most-recent non-job, non-bridge session to kind:'agent'", async () => {
    const instance = "agent-chat-promote";
    await registerAgent(instance, "agent_b");
    let olderId = "";
    let newerId = "";
    await mutateState(instance, (state) => {
      const older = createChatSession(state, "Older chat", undefined, "agent_b");
      older.updatedAt = "2024-01-01T00:00:00.000Z";
      const newer = createChatSession(state, "Newer chat", undefined, "agent_b");
      newer.updatedAt = "2024-06-01T00:00:00.000Z";
      olderId = older.id;
      newerId = newer.id;
    });

    const resolved = await getOrCreateAgentChat(instance, "agent_b");
    expect(resolved.id).toBe(newerId);
    expect(resolved.kind).toBe("agent");

    // The older session is left untouched (not merged, not promoted).
    const state = readState(instance);
    const older = state.chatSessions.find((s) => s.id === olderId);
    expect(older?.kind).toBeUndefined();
  });

  test("prefers the non-empty canonical chat and demotes an empty duplicate", async () => {
    const instance = "agent-chat-duplicate";
    await registerAgent(instance, "agent_d");
    let realId = "";
    let emptyId = "";
    await mutateState(instance, (state) => {
      // The real chat with history, marked canonical but updated earlier.
      const real = createChatSession(state, "Real chat", undefined, "agent_d", undefined, "agent");
      real.messageIds.push("m1", "m2");
      real.updatedAt = "2024-01-01T00:00:00.000Z";
      // A stray empty "New chat", also marked canonical and updated later.
      const empty = createChatSession(state, "New chat", undefined, "agent_d", undefined, "agent");
      empty.updatedAt = "2024-06-01T00:00:00.000Z";
      realId = real.id;
      emptyId = empty.id;
    });

    const resolved = await getOrCreateAgentChat(instance, "agent_d");
    // The chat with history wins over the newer-but-empty duplicate.
    expect(resolved.id).toBe(realId);
    expect(resolved.kind).toBe("agent");

    // The empty duplicate is demoted so only one canonical chat remains.
    const state = readState(instance);
    const empty = state.chatSessions.find((s) => s.id === emptyId);
    expect(empty?.kind).toBeUndefined();
    const canonical = state.chatSessions.filter(
      (s) => s.agentId === "agent_d" && s.kind === "agent"
    );
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.id).toBe(realId);
  });

  test("ignores job and bridge sessions when no agent chat exists", async () => {
    const instance = "agent-chat-skip";
    await registerAgent(instance, "agent_c");
    let liveChatId = "";
    await mutateState(instance, (state) => {
      // A job channel and a telegram bridge session for the agent — neither
      // is a promotable candidate.
      createChatSession(state, "Job channel", undefined, "agent_c", "job", "channel");
      createChatSession(
        state,
        "Telegram",
        { kind: "telegram", bridgeId: "b1", chatId: 42, target: "42" },
        "agent_c"
      );
      const live = createChatSession(state, "Live chat", undefined, "agent_c");
      live.updatedAt = "2024-03-01T00:00:00.000Z";
      liveChatId = live.id;
    });

    const resolved = await getOrCreateAgentChat(instance, "agent_c");
    // Resolver promotes the live web chat, not the channel or bridge.
    expect(resolved.id).toBe(liveChatId);
    expect(resolved.kind).toBe("agent");
  });

  test("never promotes a kind:'topic' session into the canonical chat", async () => {
    const instance = "agent-chat-topic";
    await registerAgent(instance, "agent_t");
    let topicId = "";
    await mutateState(instance, (state) => {
      // A topic session is the agent's only existing session. It must NOT be
      // promoted into the canonical chat (ADR chat-topics-tasks-subagents.md).
      const topic = createChatSession(state, "World cup trip", undefined, "agent_t", undefined, "topic");
      topic.updatedAt = "2024-05-01T00:00:00.000Z";
      topicId = topic.id;
    });

    const resolved = await getOrCreateAgentChat(instance, "agent_t");
    // The resolver mints a fresh canonical chat instead of promoting the topic.
    expect(resolved.id).not.toBe(topicId);
    expect(resolved.kind).toBe("agent");

    // The topic keeps its kind — never demoted or promoted.
    const state = readState(instance);
    const topic = state.chatSessions.find((s) => s.id === topicId);
    expect(topic?.kind).toBe("topic");
  });

  test("throws Agent not found for an unknown agent id", async () => {
    const instance = "agent-chat-unknown";
    await expect(getOrCreateAgentChat(instance, "agent_missing")).rejects.toThrow(
      "Agent not found: agent_missing"
    );
  });
});
