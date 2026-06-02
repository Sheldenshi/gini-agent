// mergeSeedWithLive() — chat-block seed-vs-live merge.
//
// Pins the fix for the seed-overwrites-live regression: useChatBlocks
// previously did `setBlocks(sorted)` on the REST snapshot resolution,
// which clobbered any live SSE block that had arrived BEFORE the
// seed promise resolved (the live frame went through the merge
// functional updater; the seed wiped the slate). The fix routes the
// seed through this helper so it merges with `prev` instead — and for
// id collisions, `prev` wins because the live frame is fresher than
// the REST snapshot.

import { describe, expect, test } from "bun:test";
import type { ChatBlock, UserTextBlock, AssistantTextBlock } from "@runtime/types";
import { mergeSeedWithLive } from "./queries";

function userBlock(id: string, ordinal: number, text: string): UserTextBlock {
  return {
    id,
    sessionId: "s1",
    instance: "test",
    ordinal,
    createdAt: "2026-05-28T00:00:00.000Z",
    kind: "user_text",
    text
  };
}

function assistantBlock(id: string, ordinal: number, text: string, streaming = false): AssistantTextBlock {
  return {
    id,
    sessionId: "s1",
    instance: "test",
    ordinal,
    createdAt: "2026-05-28T00:00:00.000Z",
    kind: "assistant_text",
    updatedAt: "2026-05-28T00:00:00.000Z",
    text,
    streaming
  };
}

describe("mergeSeedWithLive", () => {
  test("retains a live block that arrived before the seed resolved", () => {
    // Live block landed first via SSE (ordinal 2). Then the REST
    // seed lands carrying only the older block (ordinal 1). A plain
    // setBlocks(seed) would have dropped the live block; the merge
    // must keep it.
    const live: ChatBlock[] = [userBlock("live-1", 2, "live message")];
    const seed: ChatBlock[] = [userBlock("seed-1", 1, "older message")];
    const merged = mergeSeedWithLive(seed, live);
    expect(merged.map((b) => b.id)).toEqual(["seed-1", "live-1"]);
  });

  test("prev (live) wins on id collision", () => {
    // The same assistant block id is in both. The live copy has the
    // fresher streaming text — the merge must keep it, not regress
    // to the seed's older copy.
    const seedCopy = assistantBlock("a1", 1, "stale", false);
    const liveCopy = assistantBlock("a1", 1, "fresh streaming...", true);
    const merged = mergeSeedWithLive([seedCopy], [liveCopy]);
    expect(merged).toHaveLength(1);
    const only = merged[0] as AssistantTextBlock;
    expect(only.text).toBe("fresh streaming...");
    expect(only.streaming).toBe(true);
  });

  test("sorts by ordinal regardless of input order", () => {
    const seed: ChatBlock[] = [userBlock("a", 3, "third")];
    const prev: ChatBlock[] = [userBlock("b", 1, "first"), userBlock("c", 2, "second")];
    const merged = mergeSeedWithLive(seed, prev);
    expect(merged.map((b) => b.ordinal)).toEqual([1, 2, 3]);
  });

  test("empty inputs produce empty output", () => {
    expect(mergeSeedWithLive([], [])).toEqual([]);
  });

  test("empty prev returns the seed sorted", () => {
    const seed: ChatBlock[] = [userBlock("b", 2, "second"), userBlock("a", 1, "first")];
    const merged = mergeSeedWithLive(seed, []);
    expect(merged.map((b) => b.id)).toEqual(["a", "b"]);
  });

  test("empty seed returns prev sorted", () => {
    const prev: ChatBlock[] = [userBlock("b", 2, "second"), userBlock("a", 1, "first")];
    const merged = mergeSeedWithLive([], prev);
    expect(merged.map((b) => b.id)).toEqual(["a", "b"]);
  });
});
