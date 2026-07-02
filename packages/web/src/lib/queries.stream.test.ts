/// <reference lib="dom" />

// useChatBlocks SSE transport tests. These render the real hook against a
// stubbed fetch (the REST seed) and a fake global EventSource (the transport
// the resilient wrapper opens), pinning the stream contract: seed-then-merge,
// upsert-by-id with ordinal re-sort, malformed-frame tolerance, and
// close-on-unmount.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ChatBlock, UserTextBlock } from "@runtime/types";
import { useChatBlocks } from "./queries";

function block(id: string, ordinal: number, text: string): UserTextBlock {
  return {
    id,
    sessionId: "s1",
    instance: "test",
    ordinal,
    createdAt: "2026-06-10T00:00:00.000Z",
    kind: "user_text",
    text
  } as UserTextBlock;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  handlers = new Map<string, Array<(event: { data: string }) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(kind: string, handler: (event: { data: string }) => void): void {
    const list = this.handlers.get(kind) ?? [];
    list.push(handler);
    this.handlers.set(kind, list);
  }
  emit(kind: string, data: string): void {
    for (const handler of this.handlers.get(kind) ?? []) handler({ data });
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

const realFetch = globalThis.fetch;
const realEventSource = (globalThis as Record<string, unknown>).EventSource;
let seedBodies: Record<string, ChatBlock[]>;

beforeEach(() => {
  FakeEventSource.instances = [];
  seedBodies = {};
  (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.replace(/^.*\/api\/runtime/, "");
    const body = seedBodies[path];
    if (!body) return new Response(JSON.stringify({ error: `no stub for ${path}` }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEventSource === undefined) delete (globalThis as Record<string, unknown>).EventSource;
  else (globalThis as Record<string, unknown>).EventSource = realEventSource;
});

describe("useChatBlocks (SSE transport)", () => {
  test("null sessionId: no fetch, no stream, not loading", () => {
    const { result } = renderHook(() => useChatBlocks(null));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.blocks).toEqual([]);
    expect(FakeEventSource.instances.length).toBe(0);
  });

  test("seeds from the durable list, merges live frames by ordinal, upserts by id", async () => {
    seedBodies["/chat/s1/blocks"] = [block("b1", 1, "hello")];
    const { result, unmount } = renderHook(() => useChatBlocks("s1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.blocks.map((b) => b.id)).toEqual(["b1"]);
    expect(FakeEventSource.instances.length).toBe(1);
    const transport = FakeEventSource.instances[0]!;
    expect(transport.url).toBe("/api/runtime/chat/s1/stream");

    // A live frame appends and sorts by ordinal even arriving out of order.
    act(() => transport.emit("chat_block", JSON.stringify(block("b3", 3, "third"))));
    act(() => transport.emit("chat_block", JSON.stringify(block("b2", 2, "second"))));
    expect(result.current.blocks.map((b) => b.id)).toEqual(["b1", "b2", "b3"]);

    // An id collision upserts in place (streaming totals, status flips).
    act(() => transport.emit("chat_block", JSON.stringify(block("b2", 2, "second (edited)"))));
    expect(result.current.blocks.filter((b) => b.id === "b2").length).toBe(1);
    expect((result.current.blocks[1] as UserTextBlock).text).toBe("second (edited)");

    // A malformed frame is dropped without killing the stream.
    act(() => transport.emit("chat_block", "{not json"));
    expect(result.current.blocks.length).toBe(3);

    unmount();
    expect(transport.closed).toBe(true);
  });

  test("a seed failure surfaces the error without leaving the hook loading", async () => {
    // No stub registered → the seed GET 404s with a JSON error envelope.
    const { result } = renderHook(() => useChatBlocks("missing"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).not.toBeNull();
  });
});
