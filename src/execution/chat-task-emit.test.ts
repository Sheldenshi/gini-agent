// Coverage for emitToolResult: it persists a tool_result block with a
// truncated preview, and no-ops for a no-context (subagent / CLI) task. An
// agent-produced attachment reaches the user via a markdown ref the model
// pastes into its reply, not via this block. See ADR outbound-chat-attachments.md.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { closeAllMemoryDbs, listChatBlocks } from "../state";
import { emitToolResult } from "./chat-task-emit";
import type { ChatEmitContext } from "./chat-task-emit";

const ROOT = "/tmp/gini-emit-toolresult-test";

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

function ctx(instance: string, sessionId: string): ChatEmitContext {
  return { instance, sessionId, taskId: "task_emit" };
}

describe("emitToolResult", () => {
  test("returns undefined for a no-context (subagent / CLI) task", () => {
    expect(emitToolResult(undefined, { callId: "c", result: "x" })).toBeUndefined();
  });

  test("persists a short result as an untruncated preview", () => {
    const instance = "emit-toolresult-short";
    const block = emitToolResult(ctx(instance, "chat_e1"), { callId: "call_ok", result: "done" });
    if (block?.kind !== "tool_result") throw new Error("expected a tool_result block");
    expect(block.preview).toBe("done");
    expect(block.truncated).toBe(false);
    const listed = listChatBlocks(instance, "chat_e1")[0];
    if (listed?.kind !== "tool_result") throw new Error("expected a tool_result block");
    expect(listed.preview).toBe("done");
  });

  test("truncates a long preview past the 80-char cap and flags truncated", () => {
    const instance = "emit-toolresult-trunc";
    const block = emitToolResult(ctx(instance, "chat_e2"), { callId: "call_long", result: "z".repeat(200) });
    if (block?.kind !== "tool_result") throw new Error("expected a tool_result block");
    expect(block.truncated).toBe(true);
    expect(block.preview.length).toBeLessThanOrEqual(80);
    expect(block.preview.endsWith("…")).toBe(true);
  });
});
