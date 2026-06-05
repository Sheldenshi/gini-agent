import { describe, expect, test } from "bun:test";
import type { ToolCallingMessage } from "../provider";
import { packPriorContext, PRIOR_HISTORY_ELISION_NOTE, type ContextReplayMessage } from "./context-window";

function entry(message: ToolCallingMessage, threadId?: string): ContextReplayMessage {
  return {
    message,
    ...(threadId ? { threadId } : {})
  };
}

describe("prior context packing", () => {
  test("elides old history while preserving assistant tool-call groups", () => {
    const packed = packPriorContext([
      entry({ role: "user", content: `old ${"x".repeat(500)}` }),
      entry({ role: "assistant", content: "old answer" }),
      entry({ role: "user", content: "recent question" }),
      entry({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "file_read", arguments: "{\"path\":\"a.txt\"}" } }
        ]
      }),
      entry({ role: "tool", tool_call_id: "call_1", content: "recent tool result" }),
      entry({ role: "assistant", content: "recent final" })
    ], { tokenBudget: 90 });

    expect(packed.elisionInserted).toBe(true);
    expect(packed.omittedMessages).toBeGreaterThan(0);
    expect(packed.messages[0]).toEqual({ role: "user", content: PRIOR_HISTORY_ELISION_NOTE });
    expect(PRIOR_HISTORY_ELISION_NOTE).toContain("Tool-call/result pairs");
    expect(PRIOR_HISTORY_ELISION_NOTE).toContain("read_skill");
    const text = packed.messages.map((m) => String(m.content ?? "")).join("\n");
    expect(text).not.toContain("old xxx");
    expect(text).toContain("recent question");
    const assistantTool = packed.messages.find((m) => m.role === "assistant" && m.tool_calls?.[0]?.id === "call_1");
    const toolResult = packed.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_1");
    expect(assistantTool).toBeDefined();
    expect(toolResult).toBeDefined();
  });

  test("prefers active-thread history over unrelated thread history", () => {
    const packed = packPriorContext([
      entry({ role: "user", content: "active thread context alpha beta gamma" }, "thread_active"),
      entry({ role: "user", content: "other thread context alpha beta gamma" }, "thread_other")
    ], { tokenBudget: 14, activeThreadId: "thread_active" });

    const text = packed.messages.map((m) => String(m.content ?? "")).join("\n");
    expect(text).toContain(PRIOR_HISTORY_ELISION_NOTE);
    expect(text).toContain("active thread context");
    expect(text).not.toContain("other thread context");
  });
});
