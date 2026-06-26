// Tests for the Chat intake router (Phase 2, Commit B of ADR
// chat-topics-tasks-subagents.md). submitChatMessage classifies a message
// posted in a Chat (kind:"agent") session into one of three routes and
// dispatches accordingly:
//   - "chat"           → a normal chat-direct turn (answer in Chat).
//   - "new_topic"      → mint a kind:"topic" session, run the turn there, forward
//                        the final answer back into Chat.
//   - "existing_topic" → run the turn in the named Topic.
//
// The structured router decision is deterministic via the echo provider: each
// test seeds setEchoStructuredResponse("chat-route", {decision, ...}) so the
// classifier returns exactly that. The agent loop itself stays deterministic via
// the echo tool-calling stub. Setup mirrors chat-topic-forward.test.ts: HOME +
// embedding pinned to echo, a unique instance per test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  clearEchoStructuredResponses,
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoStructuredResponse,
  setEchoToolCallingResponse
} from "../provider";
import { createChatSession, createTopic, listChatBlocks, mutateState, readState } from "../state";
import type { RuntimeConfig, Task } from "../types";
import { submitChatMessage } from "./chat";

let scratchHome: string;
let prevHome: string | undefined;
let prevEmbedding: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-chat-route-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  prevEmbedding = process.env.GINI_EMBEDDING_PROVIDER;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevEmbedding === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
  else process.env.GINI_EMBEDDING_PROVIDER = prevEmbedding;
  rmSync(scratchHome, { recursive: true, force: true });
});

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7339,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-chat-route-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-chat-route-test-logs",
    approvalMode: "strict"
  };
}

async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (
      task &&
      (task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled" ||
        task.status === "waiting_approval")
    ) {
      return task;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

describe("chat intake router", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-route-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
    clearEchoStructuredResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    clearEchoToolCallingResponses();
    clearEchoStructuredResponses();
  });

  test("chat decision: runs a normal chat-direct turn, no topic minted", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-chat-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const chatId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      return chat.id;
    });

    setEchoStructuredResponse("chat-route", { decision: "chat" });
    setEchoToolCallingResponse({ provider, text: "It's 72 degrees.", toolCalls: [], finishReason: "stop" });

    const result = await submitChatMessage(config, chatId, { content: "what's the weather?" });
    if ("queued" in result) throw new Error("expected run-now submission, got queued");
    if ("topicId" in result) throw new Error("expected chat-direct submission, got topic dispatch");
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // No topic was minted.
    expect(state.chatSessions.filter((s) => s.kind === "topic").length).toBe(0);
    // The answer is a durable assistant ChatMessageRecord in the Chat session.
    const chatAnswers = state.chatMessages.filter(
      (m) =>
        m.sessionId === chatId &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(chatAnswers.length).toBe(1);
    expect(chatAnswers[0]!.content).toBe("It's 72 degrees.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("new_topic: mints a Topic for the agent, runs there, forwards the answer to Chat", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-new-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const agentId = "agent_default";
    const chatId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, agentId, undefined, "agent");
      return chat.id;
    });

    setEchoStructuredResponse("chat-route", { decision: "new_topic", title: "World Cup trip" });
    setEchoToolCallingResponse({
      provider,
      text: "I found three nonstop flights to SFO.",
      toolCalls: [],
      finishReason: "stop"
    });

    const result = await submitChatMessage(config, chatId, {
      content: "my dad and I want to fly to SF for a world cup game"
    });
    if ("queued" in result) throw new Error("expected run-now dispatch, got queued");
    if (!("topicId" in result)) throw new Error("expected a topic dispatch result");
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // A new kind:"topic" session was minted with parentChatSessionId = Chat and
    // agentId = the Chat's agent.
    const topics = state.chatSessions.filter((s) => s.kind === "topic");
    expect(topics.length).toBe(1);
    const topic = topics[0]!;
    expect(topic.id).toBe(result.topicId);
    expect(topic.title).toBe("World Cup trip");
    expect(topic.parentChatSessionId).toBe(chatId);
    expect(topic.agentId).toBe(agentId);

    // The turn ran in the Topic (replay-authoritative records live there).
    const topicAnswers = state.chatMessages.filter(
      (m) =>
        m.sessionId === topic.id &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(topicAnswers.length).toBe(1);
    expect(topicAnswers[0]!.content).toBe("I found three nonstop flights to SFO.");

    // The final answer is forwarded back into Chat as a render-only block (Commit
    // A behavior, now reached via the router).
    const forwarded = listChatBlocks(config.instance, chatId).find(
      (b) => b.kind === "assistant_text" && b.forwardedFromTopicId === topic.id
    );
    expect(forwarded).toBeDefined();
    if (forwarded!.kind === "assistant_text") {
      expect(forwarded!.text).toBe("I found three nonstop flights to SFO.");
    }

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("existing_topic: runs the turn in the named Topic, mints no new one", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-existing-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const { chatId, topicId } = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const topic = createTopic(state, {
        agentId: chat.agentId,
        title: "World Cup trip with dad",
        parentChatSessionId: chat.id
      });
      return { chatId: chat.id, topicId: topic.id };
    });

    setEchoStructuredResponse("chat-route", { decision: "existing_topic", topicId });
    setEchoToolCallingResponse({
      provider,
      text: "Booked Section 413 for both of you.",
      toolCalls: [],
      finishReason: "stop"
    });

    const result = await submitChatMessage(config, chatId, { content: "book the game tickets" });
    if ("queued" in result) throw new Error("expected run-now dispatch, got queued");
    if (!("topicId" in result)) throw new Error("expected a topic dispatch result");
    expect(result.topicId).toBe(topicId);
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // No NEW topic minted — still exactly the one seeded.
    expect(state.chatSessions.filter((s) => s.kind === "topic").length).toBe(1);

    // The turn ran in the existing Topic.
    const topicAnswers = state.chatMessages.filter(
      (m) =>
        m.sessionId === topicId &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(topicAnswers.length).toBe(1);
    expect(topicAnswers[0]!.content).toBe("Booked Section 413 for both of you.");

    // The answer forwarded back into Chat is tagged with the existing Topic.
    const forwarded = listChatBlocks(config.instance, chatId).find(
      (b) => b.kind === "assistant_text" && b.forwardedFromTopicId === topicId
    );
    expect(forwarded).toBeDefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("hardening: existing_topic with an unknown topicId downgrades to chat-direct", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-bad-id-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const chatId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      return chat.id;
    });

    setEchoStructuredResponse("chat-route", { decision: "existing_topic", topicId: "nonexistent" });
    setEchoToolCallingResponse({ provider, text: "Sure thing.", toolCalls: [], finishReason: "stop" });

    const result = await submitChatMessage(config, chatId, { content: "do the thing" });
    if ("queued" in result) throw new Error("expected run-now submission, got queued");
    // The bad topicId must NOT dispatch to a topic — it downgrades to chat-direct.
    if ("topicId" in result) throw new Error("expected chat-direct downgrade, got topic dispatch");
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // No topic was minted or targeted.
    expect(state.chatSessions.filter((s) => s.kind === "topic").length).toBe(0);
    const chatAnswers = state.chatMessages.filter(
      (m) =>
        m.sessionId === chatId &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(chatAnswers.length).toBe(1);
    expect(chatAnswers[0]!.content).toBe("Sure thing.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("hardening: new_topic with an empty title gets a content-derived stub", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-empty-title-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const chatId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      return chat.id;
    });

    setEchoStructuredResponse("chat-route", { decision: "new_topic", title: "" });
    setEchoToolCallingResponse({ provider, text: "On it.", toolCalls: [], finishReason: "stop" });

    const result = await submitChatMessage(config, chatId, {
      content: "plan a birthday party for my sister"
    });
    if ("queued" in result) throw new Error("expected run-now dispatch, got queued");
    if (!("topicId" in result)) throw new Error("expected a topic dispatch result");
    await waitForTerminal(config, result.taskId);

    const state = readState(config.instance);
    const topic = state.chatSessions.find((s) => s.id === result.topicId)!;
    // Title sanitized to a non-empty stub derived from the message.
    expect(topic.title.length).toBeGreaterThan(0);
    expect(topic.title).toBe("plan a birthday party for my");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("non-agent session: a kind:\"topic\" submit is not routed and runs in place", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    const config = buildConfig(workspaceRoot, `chat-route-non-agent-${basename(workspaceRoot)}`);
    const provider = normalizeProvider(config.provider);

    const topicId = await mutateState(config.instance, (state) => {
      const chat = createChatSession(state, "Messages", undefined, undefined, undefined, "agent");
      const topic = createTopic(state, {
        agentId: chat.agentId,
        title: "Existing topic",
        parentChatSessionId: chat.id
      });
      return topic.id;
    });

    // If routing were (incorrectly) invoked, this stub would mint a SECOND topic.
    setEchoStructuredResponse("chat-route", { decision: "new_topic", title: "Should Not Apply" });
    setEchoToolCallingResponse({ provider, text: "Done in place.", toolCalls: [], finishReason: "stop" });

    const result = await submitChatMessage(config, topicId, { content: "continue here" });
    if ("queued" in result) throw new Error("expected run-now submission, got queued");
    const finished = await waitForTerminal(config, result.taskId);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // Still exactly one topic: routing did not fire, so no second topic minted.
    expect(state.chatSessions.filter((s) => s.kind === "topic").length).toBe(1);
    expect(state.chatSessions.some((s) => s.title === "Should Not Apply")).toBe(false);

    // The turn ran in the submitted topic session itself.
    const answers = state.chatMessages.filter(
      (m) =>
        m.sessionId === topicId &&
        m.role === "assistant" &&
        m.kind !== "tool_transcript" &&
        m.kind !== "approval_reason"
    );
    expect(answers.length).toBe(1);
    expect(answers[0]!.content).toBe("Done in place.");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});
