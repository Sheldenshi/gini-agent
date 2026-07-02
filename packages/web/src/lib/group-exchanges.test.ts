// Unit tests for groupExchanges. Two behaviors matter: (1) a completed
// exchange with file writes emits one grouped file_artifact, and (2) blocks
// are partitioned into exchanges by taskId — a single agent turn or job
// cycle — so a recurring-job channel (no user_text) renders one tool group
// per cron cycle, and interleaved task blocks still reunite by task. Every
// fixture carries a taskId, mirroring production (a turn's user_text,
// assistant_text, and tool calls all share that turn's taskId). These are
// pure-JS tests over minimal ChatBlock fixtures.

import { describe, expect, test } from "bun:test";
import type { ChatBlock, ToolCallBlock } from "@runtime/types";
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

function toolResult(callId: string, taskId: string): ChatBlock {
  return { kind: "tool_result", id: `r${ordinal}`, sessionId: "s", instance: "test", ordinal: ordinal++, createdAt: "2026-01-01T00:00:00.000Z", callId, preview: "", truncated: false, taskId } as ChatBlock;
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
    // The card renders below the agent's reply: file_artifact comes after the
    // assistant_text block.
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
    // Last occurrence's toolName wins.
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
    // Each group holds exactly the one cycle's tool call, not a merged pile.
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

  test("a still-streaming cycle folds like a completed one, with its streaming reply as the trailing bubble", () => {
    const items = groupExchanges([
      ...cycle("task_done", "first"),
      ...cycle("task_live", "second", /* streaming */ true)
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    // Both cycles fold — the in-flight one no longer leaks its tool call inline.
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.calls[0]!.argsPreview)).toEqual(["first", "second"]);
    expect(items.some((i) => i.kind === "block" && i.block.kind === "tool_call")).toBe(false);
    // Each cycle's reply (the streaming one included) stays a standalone bubble.
    const bubbles = items.filter((i) => i.kind === "block" && i.block.kind === "assistant_text");
    expect(bubbles.length).toBe(2);
  });

  test("interleaved task blocks still group by task (manual run overlapping a scheduled run)", () => {
    // task_a emits its tool call, then task_b runs to completion, then task_a
    // emits its final reply — out of order in the session's ordinal stream.
    // Grouping by taskId (not contiguous run) must still form both groups.
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
    // Exchange order follows each task's first appearance: task_a, then task_b.
    expect(groups.map((g) => g.calls[0]!.argsPreview)).toEqual(["alpha", "beta"]);
    // Both groups are complete (each task's final reply closes its exchange),
    // so neither tool call leaks out as an inline block.
    expect(items.some((i) => i.kind === "block" && i.block.kind === "tool_call")).toBe(false);
  });

  test("a completed exchange with no tool calls passes its blocks through untouched", () => {
    const items = groupExchanges([user("hi", "task_chat"), assistant("hello there", "task_chat")]);
    expect(items.every((i) => i.kind === "block")).toBe(true);
    expect(items.some((i) => i.kind === "tool_group")).toBe(false);
    expect(items.length).toBe(2);
  });

  test("an exchange mid-tool-call (no final reply) folds into a group, not a loose inline tool call", () => {
    const items = groupExchanges([
      user("search", "task_run"),
      toolCall({ toolName: "web_search", argsPreview: "q", status: "running", taskId: "task_run" })
    ]);
    // In flight with a tool call → folds immediately (the collapsed group grows
    // as the turn runs); the running call lives in the group, not inline.
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    expect(groups[0]!.calls.length).toBe(1);
    expect(items.some((i) => i.kind === "block" && i.block.kind === "tool_call")).toBe(false);
  });

  test("a block with no taskId forms its own single-block exchange in place", () => {
    const items = groupExchanges([
      { kind: "phase", id: "p0", sessionId: "s", instance: "test", ordinal: ordinal++, createdAt: "2026-01-01T00:00:00.000Z", label: "thinking" } as ChatBlock
    ]);
    // No tool calls in the exchange ⇒ it passes through as a raw block, never
    // a group.
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

describe("groupExchanges narration folding", () => {
  test("a completed multi-tool exchange folds non-final narration into the process and keeps only the final answer standalone", () => {
    const items = groupExchanges([
      user("look into it", "task_n"),
      assistant("let me check", "task_n"),
      toolCall({ toolName: "web_search", argsPreview: "first", status: "ok", taskId: "task_n" }),
      assistant("found it", "task_n"),
      toolCall({ toolName: "web_fetch", argsPreview: "second", status: "ok", taskId: "task_n" }),
      assistant("answer", "task_n")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    const group = groups[0]!;
    // calls is retained — tool_call blocks only.
    expect(group.calls.length).toBe(2);
    expect(group.calls.map((c) => c.argsPreview)).toEqual(["first", "second"]);
    // steps preserve exchange order: narration, tool, narration, tool.
    expect(group.steps.map((s) => s.kind)).toEqual([
      "narration",
      "tool_call",
      "narration",
      "tool_call"
    ]);
    expect(
      group.steps.map((s) =>
        s.kind === "narration" ? s.block.text : s.block.argsPreview
      )
    ).toEqual(["let me check", "first", "found it", "second"]);
    // The only standalone assistant_text is the final answer; the
    // narration never leaks out as its own bubble.
    const standaloneAssistant = items.filter(
      (i) => i.kind === "block" && i.block.kind === "assistant_text"
    );
    expect(standaloneAssistant.length).toBe(1);
    expect(
      standaloneAssistant[0]!.kind === "block" &&
        standaloneAssistant[0]!.block.kind === "assistant_text" &&
        standaloneAssistant[0]!.block.text
    ).toBe("answer");
    // The standalone final answer is flagged so a forwarded turn shows its
    // "# topic" chip only here, not under every folded narration line.
    expect(standaloneAssistant[0]!.kind === "block" && standaloneAssistant[0]!.isFinalAnswer).toBe(true);
  });

  test("an in-flight version folds narration into the group as Thinking steps, with only the streaming answer standalone", () => {
    const items = groupExchanges([
      user("look into it", "task_stream"),
      assistant("let me check", "task_stream"),
      toolCall({ toolName: "web_search", argsPreview: "first", status: "ok", taskId: "task_stream" }),
      assistant("found it", "task_stream"),
      toolCall({ toolName: "web_fetch", argsPreview: "second", status: "ok", taskId: "task_stream" }),
      assistant("answer", "task_stream", /* streaming */ true)
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    const group = groups[0]!;
    expect(group.calls.length).toBe(2);
    // Narration folds in as "Thinking" steps, interleaved with the tool calls —
    // exactly as it would once the turn completes (no reflow on finish).
    expect(group.steps.map((s) => s.kind)).toEqual([
      "narration",
      "tool_call",
      "narration",
      "tool_call"
    ]);
    // Only the still-streaming final answer remains a standalone bubble.
    const standaloneAssistant = items.filter(
      (i) => i.kind === "block" && i.block.kind === "assistant_text"
    );
    expect(standaloneAssistant.length).toBe(1);
    const finalBubble = standaloneAssistant[0]!;
    expect(
      finalBubble.kind === "block" &&
        finalBubble.block.kind === "assistant_text" &&
        finalBubble.block.text
    ).toBe("answer");
    // The trailing answer slot is the final answer (streaming or settled), so it
    // carries isFinalAnswer; the folded narration never does, so a forwarded turn
    // shows its "# topic" chip only on this closing reply.
    expect(finalBubble.kind === "block" && finalBubble.isFinalAnswer).toBe(true);
  });

  test("a completed no-tool exchange flags only its lone reply as the final answer", () => {
    const items = groupExchanges([user("hi", "task_q"), assistant("hello there", "task_q")]);
    const standaloneAssistant = items.filter(
      (i) => i.kind === "block" && i.block.kind === "assistant_text"
    );
    expect(standaloneAssistant.length).toBe(1);
    expect(standaloneAssistant[0]!.kind === "block" && standaloneAssistant[0]!.isFinalAnswer).toBe(true);
  });
});

describe("groupExchanges in-flight expansion", () => {
  // The tool_group carries `inProgress` so the renderer can keep an actively
  // generating turn EXPANDED (each tool call visible as it lands) and collapse
  // it to the one-line summary only once the turn settles.
  test("a turn still mid-tool-call is inProgress", () => {
    const items = groupExchanges([
      user("search", "task_live"),
      toolCall({ toolName: "web_search", argsPreview: "q", status: "running", taskId: "task_live" })
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    expect(groups[0]!.inProgress).toBe(true);
  });

  test("a turn whose reply is still streaming is inProgress", () => {
    const items = groupExchanges([
      user("look", "task_stream2"),
      toolCall({ toolName: "web_search", argsPreview: "q", status: "ok", taskId: "task_stream2" }),
      assistant("typing", "task_stream2", /* streaming */ true)
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups[0]!.inProgress).toBe(true);
  });

  test("a settled turn is not inProgress (collapses to the summary)", () => {
    const items = groupExchanges([
      user("look", "task_done2"),
      toolCall({ toolName: "web_search", argsPreview: "q", status: "ok", taskId: "task_done2" }),
      assistant("here you go", "task_done2")
    ]);
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups[0]!.inProgress).toBe(false);
  });

  test("a terminal run that stopped on a tool call is not inProgress", () => {
    const items = groupExchanges(
      [
        toolCall({ toolName: "web_search", argsPreview: "q", status: "ok", taskId: "task_term3" }),
        toolResult("call-x", "task_term3")
      ],
      new Set(["task_term3"])
    );
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups[0]!.inProgress).toBe(false);
  });
});

describe("groupExchanges terminal narration folding", () => {
  test("a terminal run that ended on a tool call (no final answer) folds all narration with no standalone bubble", () => {
    // The run carries a "Completed" phase (terminal) but the model stopped
    // after a tool call — its last assistant_text precedes that call. The
    // caller passes the taskId in terminalTaskIds; everything folds.
    const items = groupExchanges(
      [
        assistant("narration", "task_term"),
        toolCall({ toolName: "web_search", argsPreview: "first", status: "ok", taskId: "task_term" }),
        toolResult("call-1", "task_term"),
        assistant("court", "task_term"),
        toolCall({ toolName: "web_fetch", argsPreview: "second", status: "ok", taskId: "task_term" }),
        toolResult("call-2", "task_term")
      ],
      new Set(["task_term"])
    );
    const groups = items.filter((i) => i.kind === "tool_group");
    expect(groups.length).toBe(1);
    const group = groups[0]!;
    expect(group.calls.length).toBe(2);
    expect(group.calls.map((c) => c.argsPreview)).toEqual(["first", "second"]);
    // Both pre-tool narration lines fold into the process as steps.
    const narrationSteps = group.steps.filter((s) => s.kind === "narration");
    expect(narrationSteps.map((s) => s.kind === "narration" && s.block.text)).toEqual([
      "narration",
      "court"
    ]);
    // No assistant_text leaks out as a standalone bubble.
    expect(items.some((i) => i.kind === "block" && i.block.kind === "assistant_text")).toBe(false);
  });
});
