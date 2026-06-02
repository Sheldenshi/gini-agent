// Unit tests for the file-artifact extraction in groupExchanges. A completed
// exchange that contains successful file_write/file_patch tool calls should
// emit one "file_artifact" render item carrying every unique generated-file
// path, so the chat UI can show one grouped card for the exchange. These are
// pure-JS tests: they build minimal ChatBlock fixtures and assert on the
// render-item shape.

import { describe, expect, test } from "bun:test";
import type { ChatBlock, ToolCallBlock } from "@runtime/types";
import { groupExchanges } from "./group-exchanges";

let ordinal = 0;

function user(text: string): ChatBlock {
  return { kind: "user_text", id: `u${ordinal}`, sessionId: "s", instance: "test", ordinal: ordinal++, createdAt: "2026-01-01T00:00:00.000Z", text } as ChatBlock;
}

function assistant(text: string, streaming = false): ChatBlock {
  return { kind: "assistant_text", id: `a${ordinal}`, sessionId: "s", instance: "test", ordinal: ordinal++, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", text, streaming } as ChatBlock;
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

describe("groupExchanges file artifacts", () => {
  test("a completed exchange with a successful file_write yields one grouped file_artifact", () => {
    const items = groupExchanges([
      user("write a note"),
      toolCall({ toolName: "file_write", argsFull: { path: "note.md" }, status: "ok" }),
      assistant("done")
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
      user("write two"),
      toolCall({ toolName: "file_write", argsFull: { path: "a.md" }, status: "ok" }),
      toolCall({ toolName: "file_write", argsFull: { path: "b.md" }, status: "ok" }),
      assistant("done")
    ]);
    const artifacts = items.filter((i) => i.kind === "file_artifact");
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]!.files.length).toBe(2);
    expect(artifacts[0]!.files.map((f) => f.path)).toEqual(["a.md", "b.md"]);
  });

  test("two writes to the same path dedupe to one file", () => {
    const items = groupExchanges([
      user("write twice"),
      toolCall({ toolName: "file_write", argsFull: { path: "note.md" }, status: "ok" }),
      toolCall({ toolName: "file_patch", argsFull: { path: "note.md" }, status: "ok" }),
      assistant("done")
    ]);
    const artifacts = items.filter((i) => i.kind === "file_artifact");
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]!.files.length).toBe(1);
    // Last occurrence's toolName wins.
    expect(artifacts[0]!.files[0]).toMatchObject({ path: "note.md", toolName: "file_patch" });
  });

  test("a failed file_write yields no artifact", () => {
    const items = groupExchanges([
      user("write a note"),
      toolCall({ toolName: "file_write", argsFull: { path: "note.md" }, status: "error" }),
      assistant("failed")
    ]);
    expect(items.some((i) => i.kind === "file_artifact")).toBe(false);
  });

  test("an incomplete exchange yields no artifact", () => {
    const items = groupExchanges([
      user("write a note"),
      toolCall({ toolName: "file_write", argsFull: { path: "note.md" }, status: "ok" }),
      assistant("typing", true)
    ]);
    expect(items.some((i) => i.kind === "file_artifact")).toBe(false);
  });
});
