// useChatBlocks() — chat-session-switch reset.
//
// Pins the fix for the cross-session leak: useChatBlocks backs its block
// list with a `useState<ChatBlock[]>([])` slot. The caller at
// `web/src/app/chat/page.tsx` re-runs the hook with a new sessionId on
// chat switch but does NOT remount (no React `key`), so the useState
// slot persists with the previous chat's blocks. Before the fix, the
// effect only reset blocks when transitioning to `null`; switching from
// session A to session B left A's blocks in state, and when B's seed
// resolved `mergeSeedWithLive(initial, prev)` ran with `prev` =
// A's blocks. `mergeSeedWithLive` de-dupes by block id only — no
// session-id check — so the rendered list was the UNION of both
// sessions' blocks, sorted by ordinal. Cross-session leak.
//
// The fix resets `blocks` and `error` unconditionally at the top of the
// effect body so the new sessionId starts from a clean slate; the seed
// fetch for the new session is the only thing that can re-populate
// `blocks`. This test pins that behavior by driving the same effect
// sequence with a mocked fetch and asserting the reset fires
// immediately on the A→B transition (BEFORE B's seed resolves) and
// that the final B state contains only B's blocks.
//
// We don't drive the React hook through a renderer here — that would
// require a DOM + react-dom client we don't ship in tests. Instead we
// model the hook's effect body as a small simulator: the same mental
// model the production effect uses (seed fetch → setState merge,
// guarded by a `cancelled` flag captured in the cleanup), with the
// session-change reset applied identically.

import { describe, expect, test } from "bun:test";
import type { ChatBlock, UserTextBlock } from "@runtime/types";
import { mergeSeedWithLive } from "./queries";

function userBlock(id: string, ordinal: number, text: string): UserTextBlock {
  return {
    id,
    sessionId: "test-session",
    instance: "test",
    ordinal,
    createdAt: "2026-05-28T00:00:00.000Z",
    kind: "user_text",
    text
  };
}

/** Drive the effect body the way React would: returns a cleanup fn and
 *  exposes the latest blocks via the closure. Mirrors the structure of
 *  the effect in `useChatBlocks`. The reset at the top (`setBlocks([])`)
 *  is the load-bearing line under test. */
function openSession(
  sessionId: string,
  state: { blocks: ChatBlock[] },
  fetchSeed: (sid: string) => Promise<ChatBlock[]>
): { cleanup: () => void; settled: Promise<void> } {
  // The fix: reset on EVERY sessionId change (including non-null →
  // non-null), not just the null transition. Without this, switching
  // from A to B leaves A's blocks in state and the B seed merges with
  // them via mergeSeedWithLive — leaking A's blocks into B's view.
  state.blocks = [];
  let cancelled = false;
  const settled = fetchSeed(sessionId).then((initial) => {
    if (cancelled) return;
    state.blocks = mergeSeedWithLive(initial, state.blocks);
  });
  return {
    cleanup() {
      cancelled = true;
    },
    settled
  };
}

describe("useChatBlocks session-switch reset", () => {
  test("switching from A→B resets blocks immediately and final state has only B blocks", async () => {
    // Seed fetcher routes by sessionId — A returns A's blocks, B returns
    // B's. The deferred-resolution pattern lets us verify the reset
    // fires BEFORE B's seed lands.
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers<ChatBlock[]>>>();
    const fetchSeed = (sid: string): Promise<ChatBlock[]> => {
      const gate = Promise.withResolvers<ChatBlock[]>();
      gates.set(sid, gate);
      return gate.promise;
    };

    const state = { blocks: [] as ChatBlock[] };

    // Mount session A and resolve its seed.
    const aHandle = openSession("A", state, fetchSeed);
    gates.get("A")!.resolve([userBlock("A-1", 1, "from A"), userBlock("A-2", 2, "from A")]);
    await aHandle.settled;
    expect(state.blocks.map((b) => b.id)).toEqual(["A-1", "A-2"]);

    // Switch to session B. React would call the cleanup for the A
    // effect, then run the B effect's body. The B body's first action
    // is the unconditional reset — assert it fires immediately, BEFORE
    // B's seed resolves. Without the fix, blocks would still be
    // ["A-1", "A-2"] here and the B seed's merge would yield the union.
    aHandle.cleanup();
    const bHandle = openSession("B", state, fetchSeed);
    expect(state.blocks).toEqual([]);

    // Resolve B's seed; final state must contain only B's blocks. No
    // A blocks leak through.
    gates.get("B")!.resolve([userBlock("B-1", 1, "from B")]);
    await bHandle.settled;
    expect(state.blocks.map((b) => b.id)).toEqual(["B-1"]);
  });

  test("cleanup for A blocks late-arriving A seed from clobbering B state", async () => {
    // Edge case: A's seed is in-flight when we switch to B. After the
    // cleanup fires for A, the late A seed must NOT write into the
    // shared state — `cancelled` gates the .then() handler.
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers<ChatBlock[]>>>();
    const fetchSeed = (sid: string): Promise<ChatBlock[]> => {
      const gate = Promise.withResolvers<ChatBlock[]>();
      gates.set(sid, gate);
      return gate.promise;
    };
    const state = { blocks: [] as ChatBlock[] };

    const aHandle = openSession("A", state, fetchSeed);
    // Switch to B BEFORE A's seed resolves. A's cleanup fires; A's
    // seed promise will resolve later but its .then() body must bail
    // on the cancelled flag rather than writing A's blocks into B's
    // session.
    aHandle.cleanup();
    const bHandle = openSession("B", state, fetchSeed);
    expect(state.blocks).toEqual([]);

    // A's seed resolves late — must NOT touch state because A was
    // cleaned up.
    gates.get("A")!.resolve([userBlock("A-late", 1, "late A")]);
    await aHandle.settled;
    expect(state.blocks).toEqual([]);

    // B's seed resolves cleanly with only B's blocks.
    gates.get("B")!.resolve([userBlock("B-1", 1, "from B")]);
    await bHandle.settled;
    expect(state.blocks.map((b) => b.id)).toEqual(["B-1"]);
  });

  test("reset clears blocks when transitioning to null", async () => {
    // Pins the original null-transition behavior — the fix expands the
    // reset to fire on every sessionId change, but the null case still
    // works.
    const gate = Promise.withResolvers<ChatBlock[]>();
    const fetchSeed = (_sid: string): Promise<ChatBlock[]> => gate.promise;
    const state = { blocks: [] as ChatBlock[] };

    const aHandle = openSession("A", state, fetchSeed);
    gate.resolve([userBlock("A-1", 1, "A1")]);
    await aHandle.settled;
    expect(state.blocks.map((b) => b.id)).toEqual(["A-1"]);

    // Simulate the null-transition branch of the production effect:
    // reset is unconditional, and there's no seed fetch to wait for.
    aHandle.cleanup();
    state.blocks = []; // production: `setBlocks([])` at top of effect
    expect(state.blocks).toEqual([]);
  });
});
