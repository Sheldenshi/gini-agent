// Unit tests for groupExchanges. Two behaviors matter: (1) a completed
// exchange with file writes emits one grouped file_artifact, and (2) blocks
// are partitioned into exchanges by taskId — a single agent turn or job
// cycle — so a recurring-job channel (no user_text) renders one tool group
// per cron cycle, and interleaved task blocks still reunite by task. Every
// fixture carries a taskId, mirroring production (a turn's user_text,
// assistant_text, and tool calls all share that turn's taskId). These are
// pure-JS tests over minimal ChatBlock fixtures.

import { describe, expect, test } from "bun:test";
import type { ChatBlock, ToolCallBlock } from "@/src/types";
import { groupExchanges } from "./group-exchanges";

let ordinal = 0;

function user(text: string, taskId: string): ChatBlock {
  return { kind: "user_text", id: `u${ordinal}`, sessionId: "s", instance: "test", ordinal: ordinal++, createdAt: "2026-01-01T00:00:00.000Z", text, taskId } as ChatBlock;
}

function assistant(text: string, taskId: string, streaming = false): ChatBlock {
  return { kind: "assistant_text", id: `a${ordinal}`, sessionId: "s", instance: "test", ordinal: ordinal++, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", text, streaming, taskId } as ChatBlock;
}

function toolCall(overrides: Partial<ToolCallBlock>): ChatBlock {
  return {
    kind: "tool_call",
    id: `t${ordinal}`,
    sessionId: "s",
    instance: "test",
    ordinal: ordinal++,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    toolName: "file_write",
    displayLabel: "Write file",
    argsPreview: "",
    argsFull: {},
    status: "ok",
    callId: `call-${ordinal}`,
    ...overrides
  } as ChatBlock;
}

// A job-cycle exchange: an assistant preamble, a tool call, and a final
// reply, all stamped with the same taskId. Recurring-job channels emit these
// with no user_text — the cycle is triggered by cron, not a user message.
function cycle(taskId: string, query: string, streaming = false): ChatBlock[] {
  return [
    assistant("checking", taskId),
    toolCall({ toolName: "web_search", argsPreview: query, argsFull: { query }, status: "ok", taskId }),
    assistant("No major news this cycle.", taskId, streaming)
  ];
}

describe("groupExchanges file artifacts", () => {
  test("a completed exchange with a successful file_write yields one grouped file_artifact", () => {
    const items = groupExchanges([
      user("write a note", "task_1"),
      toolCall({ toolName: "file_write", argsFull: { path: "note.md" }, status: "ok", taskId: "task_1" }),
      assistant("done", "task_1")
    ]);
    const artifacts = items.filter((i) => i.kind === "file_artifact");
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]!.files.length).toBe(1);
    expect(artifacts[0]!.files[0]).toMatchObject({ path: "note.md", toolName: "file_write" });
    const assistantIdx = items.findIndex((i) => i.kind === "block" && i.block.kind === "assistant_text");
    const artifactIdx = items.findIndex((i) => i.kind === "file_artifact");
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(artifactIdx).toBeGreaterThan(assistantIdx);
  });

  test("two distinct paths group into one artifact carrying both files", () => {
    const items = groupExchanges([
      user("write two", "task_2"),
      toolCall({ toolName: "file_write", argsFull: { path: "a.md" }, status: "ok", taskId: "task_2" }),
      toolCall({ toolName: "file_write", argsFull: { path: "b.md" }, status: "ok", taskId: "task_2" }),
      assistant("done", "task_2")
    ]);
    const artifacts = items.filter((i) => i.kind === "file_artifact");
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]!.files.length).toBe(2);
    expect(artifacts[0]!.files.map((f) => f.path)).toEqual(["a.md", "b.md"]);
  });

  test("two writes to the same path dedupe to one file", () => {
    const items = groupExchanges([
      user("write twice", "task_3"),
      toolCall({ toolName: "file_write", argsFull: { path: "note.md" }, status: "ok", taskId: "task_3" }),
      toolCall({ toolName: "file_patch", argsFull: { path: "note.md" }, status: "ok", taskId: "task_3" }),
      assistant("done", "task_3")
    ]);
    const artifacts = items.filter((i) => i.kind === "file_artifact");
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]!.files.length).toBe(1);
    expect(artifacts[0]!.files[0]).toMatchObject({ path: "note.md", toolName: "file_patch" });
  });

  test("a failed file_write yields no artifact", () => {
    const items = groupExchanges([
      user("write a note", "task_4"),
      toolCall({ toolName: "file_write", argsFull: { path: "note.md" }, status: "error", taskId: "task_4" }),
      assistant("failed", "task_4")
    ]);
    expect(items.some((i) => i.kind === "file_artifact")).toBe(false);
  });

  test("an incomplete exchange yields no artifact", () => {
    const items = groupExchanges([
      user("write a note", "task_5"),
      toolCall({ toolName: "file_write", argsFull: { path: "note.md" }, status: "ok", taskId: "task_5" }),
      assistant("typing", "task_5", true)
    ]);
    expect(items.some((i) => i.kind === "file_artifact")).toBe(false);
  });
});

describe("groupExchanges by taskId", () => {
  test("each cron cycle (no user_text, distinct taskId) gets its own tool group", () => {
    const items = groupExchanges([
      ...cycle("task_a", "breaking news today"),
      ...cycle("task_b", "stock market June 15"),
      ...cycle("task_c", "AI launch June 15")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(3);
    expect(groups.every((g) => g.calls.length === 1)).toBe(true);
    expect(groups.map((g) => g.calls[0]!.argsPreview)).toEqual([
      "breaking news today",
      "stock market June 15",
      "AI launch June 15"
    ]);
  });

  test("a single cycle's multiple tool calls stay in one group", () => {
    const taskId = "task_solo";
    const items = groupExchanges([
      assistant("checking", taskId),
      toolCall({ toolName: "web_search", argsPreview: "q1", status: "ok", taskId }),
      toolCall({ toolName: "web_fetch", argsPreview: "q2", status: "ok", taskId }),
      assistant("done", taskId)
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    expect(groups[0]!.calls.length).toBe(2);
  });

  test("the latest cycle still streaming stays inline (no premature group)", () => {
    const items = groupExchanges([
      ...cycle("task_done", "first"),
      ...cycle("task_live", "second", /* streaming */ true)
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    expect(groups[0]!.calls[0]!.argsPreview).toBe("first");
    const inlineToolCalls = items.filter((i) => i.kind === "block" && i.block.kind === "tool_call");
    expect(inlineToolCalls.length).toBe(1);
  });

  test("interleaved task blocks still group by task (manual run overlapping a scheduled run)", () => {
    const items = groupExchanges([
      assistant("checking", "task_a"),
      toolCall({ toolName: "web_search", argsPreview: "alpha", status: "ok", taskId: "task_a" }),
      assistant("checking", "task_b"),
      toolCall({ toolName: "web_search", argsPreview: "beta", status: "ok", taskId: "task_b" }),
      assistant("done b", "task_b"),
      assistant("done a", "task_a")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.calls[0]!.argsPreview)).toEqual(["alpha", "beta"]);
    expect(items.some((i) => i.kind === "block" && i.block.kind === "tool_call")).toBe(false);
  });

  test("a completed exchange with no tool calls passes its blocks through untouched", () => {
    const items = groupExchanges([user("hi", "task_chat"), assistant("hello there", "task_chat")]);
    expect(items.every((i) => i.kind === "block")).toBe(true);
    expect(items.some((i) => i.kind === "tool_group")).toBe(false);
    expect(items.length).toBe(2);
  });

  test("an exchange ending on a running tool call (no final reply) stays inline", () => {
    const items = groupExchanges([
      user("search", "task_run"),
      toolCall({ toolName: "web_search", argsPreview: "q", status: "running", taskId: "task_run" })
    ]);
    expect(items.some((i) => i.kind === "tool_group")).toBe(false);
    expect(items.filter((i) => i.kind === "block" && i.block.kind === "tool_call").length).toBe(1);
  });

  test("a block with no taskId forms its own single-block exchange in place", () => {
    const items = groupExchanges([
      { kind: "phase", id: "p0", sessionId: "s", instance: "test", ordinal: ordinal++, createdAt: "2026-01-01T00:00:00.000Z", label: "thinking" } as ChatBlock
    ]);
    expect(items.some((i) => i.kind === "tool_group")).toBe(false);
    expect(items).toEqual([{ kind: "block", block: expect.objectContaining({ kind: "phase" }) }]);
  });

  test("a user turn in a job channel groups separately from the cron cycles", () => {
    const items = groupExchanges([
      ...cycle("task_a", "auto cycle"),
      user("hey, anything on sports?", "task_user"),
      assistant("checking", "task_user"),
      toolCall({ toolName: "web_search", argsPreview: "sports scores", status: "ok", taskId: "task_user" }),
      assistant("here you go", "task_user")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.calls[0]!.argsPreview)).toEqual(["auto cycle", "sports scores"]);
  });
});
