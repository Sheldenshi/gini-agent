// Integration tests for the per-turn chat-vs-thread routing directive.
//
// The agent decides whether a reply lands in the main chat (default) or a
// thread branched off its last message by emitting a leading control
// directive `<route>thread</route>` / `<route>chat</route>` as the very first
// text of its response. The runtime parses + STRIPS the directive before it
// reaches the user (assistant_text block), the task summary, or the partial
// summary, and — when `thread` — threads the entire turn off the prior
// main-chat assistant message.
//
// We drive real turns through submitChatMessage with the echo provider's
// stubbed tool-calling responses so the loop is fully deterministic.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoToolCallingResponse
} from "../provider";
import {
  createTask,
  listChatBlocks,
  listThreadBlocks,
  mutateState,
  readState,
  upsertTask
} from "../state";
import { listMainChatBlocks } from "../state/chat-blocks";
import type { ChatBlock, RuntimeConfig, Task } from "../types";
import { createChat, submitChatMessage } from "./chat";
import { runChatTask } from "./chat-task";

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7339,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-chat-route-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-chat-route-test-logs"
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

function assistantText(block: ChatBlock): string {
  return block.kind === "assistant_text" ? block.text : "";
}

describe("chat-task route directive", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-route-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-route-ws-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  // Runs a first main-chat turn so a prior assistant_text block exists for the
  // routing turn to branch a thread from, then returns the session id + the
  // last main-chat assistant block id.
  async function seedFirstTurn(
    config: RuntimeConfig,
    provider: ReturnType<typeof normalizeProvider>
  ): Promise<{ sessionId: string; parentBlockId: string }> {
    setEchoToolCallingResponse({
      provider,
      text: "First main-chat answer.",
      toolCalls: [],
      finishReason: "stop"
    });
    const session = await createChat(config, { title: "route-test" });
    const first = await submitChatMessage(config, session.id, { content: "hello" });
    await waitForTerminal(config, first.taskId);
    const main = listMainChatBlocks(config.instance, session.id);
    const lastAssistant = [...main].reverse().find((b) => b.kind === "assistant_text");
    expect(lastAssistant).toBeDefined();
    return { sessionId: session.id, parentBlockId: lastAssistant!.id };
  }

  test("threads the turn, strips the directive from block + summary, roots at the prior assistant", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-thread");
    const provider = normalizeProvider(config.provider);
    const { sessionId, parentBlockId } = await seedFirstTurn(config, provider);

    setEchoToolCallingResponse({
      provider,
      text: "<route>thread</route>\nLet's dig into this in a thread.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, sessionId, { content: "research this" });
    const finished = await waitForTerminal(config, second.taskId);

    // (a) The directive never reaches the summary nor the partial summary.
    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Let's dig into this in a thread.");
    expect(finished.summary).not.toContain("<route>");
    expect(finished.partialSummary ?? "").not.toContain("<route>");

    // (b) The new assistant block carries threadId and parentBlockId pointing
    //     at the prior main-chat assistant block, and its text is clean.
    const threadAssistant = listChatBlocks(config.instance, sessionId)
      .filter((b) => b.kind === "assistant_text" && b.taskId === second.taskId);
    expect(threadAssistant.length).toBe(1);
    const block = threadAssistant[0]!;
    expect(assistantText(block)).toBe("Let's dig into this in a thread.");
    expect(assistantText(block)).not.toContain("<route>");
    expect(block.threadId).toBeDefined();
    expect(block.parentBlockId).toBe(parentBlockId);

    // The whole turn's blocks (assistant text + phases) share the thread id.
    const threadId = block.threadId!;
    const threadBlocks = listThreadBlocks(config.instance, sessionId, threadId);
    expect(threadBlocks.length).toBeGreaterThan(0);
    for (const tb of threadBlocks) {
      expect(tb.threadId).toBe(threadId);
    }

    // (c) The thread id is persisted on the task.
    expect(finished.threadId).toBe(threadId);
    expect(finished.parentBlockId).toBe(parentBlockId);
  });

  test("<route>chat</route> stays in the main chat and strips the directive", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-chat");
    const provider = normalizeProvider(config.provider);
    const { sessionId } = await seedFirstTurn(config, provider);

    setEchoToolCallingResponse({
      provider,
      text: "<route>chat</route>Quick answer, no thread.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, sessionId, { content: "quick q" });
    const finished = await waitForTerminal(config, second.taskId);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Quick answer, no thread.");
    expect(finished.threadId).toBeUndefined();

    const blocks = listChatBlocks(config.instance, sessionId)
      .filter((b) => b.kind === "assistant_text" && b.taskId === second.taskId);
    expect(blocks.length).toBe(1);
    expect(assistantText(blocks[0]!)).toBe("Quick answer, no thread.");
    expect(blocks[0]!.threadId).toBeUndefined();
  });

  test("no directive stays in the main chat with text untouched", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-none");
    const provider = normalizeProvider(config.provider);
    const { sessionId } = await seedFirstTurn(config, provider);

    setEchoToolCallingResponse({
      provider,
      text: "Plain main-chat reply.",
      toolCalls: [],
      finishReason: "stop"
    });
    const second = await submitChatMessage(config, sessionId, { content: "and?" });
    const finished = await waitForTerminal(config, second.taskId);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Plain main-chat reply.");
    expect(finished.threadId).toBeUndefined();

    const blocks = listChatBlocks(config.instance, sessionId)
      .filter((b) => b.kind === "assistant_text" && b.taskId === second.taskId);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.threadId).toBeUndefined();
  });

  test("a directive on the very first turn (no prior assistant) stays in main chat but strips it", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-firstturn");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "<route>thread</route>Nothing to branch from yet.",
      toolCalls: [],
      finishReason: "stop"
    });
    const session = await createChat(config, { title: "first-turn" });
    const first = await submitChatMessage(config, session.id, { content: "go" });
    const finished = await waitForTerminal(config, first.taskId);

    expect(finished.status).toBe("completed");
    // Directive still stripped even though we could not thread.
    expect(finished.summary).toBe("Nothing to branch from yet.");
    expect(finished.threadId).toBeUndefined();

    const blocks = listChatBlocks(config.instance, session.id)
      .filter((b) => b.kind === "assistant_text" && b.taskId === first.taskId);
    expect(blocks.length).toBe(1);
    expect(assistantText(blocks[0]!)).toBe("Nothing to branch from yet.");
    expect(blocks[0]!.threadId).toBeUndefined();
  });

  test("start_thread tool call branches the turn into a thread with no visible control blocks", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-startthread");
    const provider = normalizeProvider(config.provider);
    const { sessionId, parentBlockId } = await seedFirstTurn(config, provider);

    // Turn 1 of the routing turn: the model's FIRST action is a start_thread
    // control tool call (no text). Turn 2: it replies with the actual answer
    // plus a sibling tool call. Both must thread off the prior assistant.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_start", type: "function", function: { name: "start_thread", arguments: JSON.stringify({ topic: "app names" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Here are 5 names to start.",
      toolCalls: [
        { id: "call_read", type: "function", function: { name: "file_list", arguments: JSON.stringify({ path: "." }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Done — pick a favorite and we'll iterate.",
      toolCalls: [],
      finishReason: "stop"
    });

    const second = await submitChatMessage(config, sessionId, { content: "brainstorm app names" });
    const finished = await waitForTerminal(config, second.taskId);
    expect(finished.status).toBe("completed");

    const turnBlocks = listChatBlocks(config.instance, sessionId).filter((b) => b.taskId === second.taskId);

    // start_thread emits NO phase / tool_call / tool_result control blocks.
    const startThreadCallBlocks = turnBlocks.filter(
      (b) => b.kind === "tool_call" && b.callId === "call_start"
    );
    expect(startThreadCallBlocks.length).toBe(0);
    const startThreadToolBlocks = turnBlocks.filter(
      (b) => b.kind === "tool_call" && b.toolName === "start_thread"
    );
    expect(startThreadToolBlocks.length).toBe(0);
    expect(turnBlocks.some((b) => b.kind === "tool_result" && b.callId === "call_start")).toBe(false);

    // The subsequent assistant text + the sibling file_list tool call all
    // carry the minted threadId and root at the prior main-chat assistant.
    const assistantBlocks = turnBlocks.filter((b) => b.kind === "assistant_text");
    expect(assistantBlocks.length).toBeGreaterThan(0);
    const threadId = assistantBlocks[0]!.threadId;
    expect(threadId).toBeDefined();
    expect(assistantBlocks[0]!.parentBlockId).toBe(parentBlockId);
    // Every CONTENT block the turn produces after the switch carries the
    // thread id: the assistant text, the sibling file_list tool call, and its
    // result. (The routed turn's user_text prompt and the leading "Thinking"
    // phase are emitted BEFORE the model's first action — start_thread — so
    // they legitimately stay in the main chat, exactly like the `<route>`
    // streaming path before its first delta resolves.)
    const contentBlocks = turnBlocks.filter(
      (b) => b.kind === "assistant_text" || b.kind === "tool_call" || b.kind === "tool_result"
    );
    expect(contentBlocks.length).toBeGreaterThan(0);
    for (const b of contentBlocks) {
      expect(b.threadId).toBe(threadId);
    }
    const siblingCall = turnBlocks.find((b) => b.kind === "tool_call" && b.toolName === "file_list");
    expect(siblingCall?.threadId).toBe(threadId);

    // The thread id is persisted onto the task and the thread surfaces.
    expect(finished.threadId).toBe(threadId);
    expect(finished.parentBlockId).toBe(parentBlockId);
    const threadBlocks = listThreadBlocks(config.instance, sessionId, threadId!);
    expect(threadBlocks.length).toBeGreaterThan(0);
  });

  test("start_thread with no prior assistant stays in the main chat", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-startthread-noparent");
    const provider = normalizeProvider(config.provider);

    // First-ever turn: no prior main-chat assistant block to branch from.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_start", type: "function", function: { name: "start_thread", arguments: "{}" } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Replying in the main chat.",
      toolCalls: [],
      finishReason: "stop"
    });

    const session = await createChat(config, { title: "startthread-noparent" });
    const first = await submitChatMessage(config, session.id, { content: "brainstorm app names" });
    const finished = await waitForTerminal(config, first.taskId);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Replying in the main chat.");
    expect(finished.threadId).toBeUndefined();

    const blocks = listChatBlocks(config.instance, session.id)
      .filter((b) => b.kind === "assistant_text" && b.taskId === first.taskId);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.threadId).toBeUndefined();
  });

  test("a task pre-seeded with task.threadId threads its whole response with no directive", async () => {
    const config = buildConfig(workspaceRoot, "chat-route-preseed");
    const provider = normalizeProvider(config.provider);
    const { sessionId, parentBlockId } = await seedFirstTurn(config, provider);

    // The reply carries NO directive — pre-seeding must thread it anyway.
    setEchoToolCallingResponse({
      provider,
      text: "Replying inside the existing thread.",
      toolCalls: [],
      finishReason: "stop"
    });

    // Build the task with the thread fields already set (mirrors how the
    // Phase 0c thread-reply endpoint spawns it) and run it directly so the
    // loop resolves its emit context from the pre-seeded fields with no race.
    const seededThreadId = "thread_preseed";
    const task = createTask(config.instance, "thread reply", undefined, undefined, undefined, undefined, undefined, sessionId);
    task.mode = "chat";
    task.threadId = seededThreadId;
    task.parentBlockId = parentBlockId;
    await mutateState(config.instance, (state) => {
      upsertTask(state, task);
    });
    const finished = await runChatTask(config, task.id);

    expect(finished.status).toBe("completed");
    expect(finished.summary).toBe("Replying inside the existing thread.");

    const blocks = listChatBlocks(config.instance, sessionId)
      .filter((b) => b.kind === "assistant_text" && b.taskId === task.id);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.threadId).toBe(seededThreadId);
    expect(blocks[0]!.parentBlockId).toBe(parentBlockId);
  });
});
