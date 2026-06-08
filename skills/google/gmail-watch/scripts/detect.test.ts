// Unit tests for the stateless gmail-watch detection engine (ADR email-watch.md).
//
// Covers the pure helpers (gws JSON / NDJSON-window / metadata parsers, the
// safety floor, the raw match item) AND the watcher-state regimes (seeding,
// dedup, truncation, oldest-first backlog drain, same-second siblings, the
// after: watermark bound) by calling `detect` directly with an injected gws
// spawn — no child process, no state store (the engine is pure: state in, state
// out). The R1–R3 hardening pins are preserved here at the engine's new home.

import { describe, expect, test } from "bun:test";
import {
  buildMatchItem,
  detect,
  parseFromAddress,
  parseGwsAuthStatus,
  shouldDropMessage,
  type GwsSpawn
} from "./detect";

interface Meta {
  id: string;
  internalDate?: string;
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
}

const PREAMBLE = "Using keyring backend: keyring\n";

function listResponse(ids: string[]): string {
  return PREAMBLE + JSON.stringify({ messages: ids.map((id) => ({ id, threadId: id })) });
}

// Multi-page NDJSON `--page-all` response. `pages` is a list of id-arrays,
// newest-first across and within pages; the last page carries a nextPageToken
// only when `truncated` is set (the page-cap-hit signal).
function pagedListResponse(pages: string[][], truncated = false): string {
  const lines = pages.map((ids, i) => {
    const isLast = i === pages.length - 1;
    const doc: Record<string, unknown> = { messages: ids.map((id) => ({ id, threadId: id })) };
    if (!isLast || truncated) doc.nextPageToken = `tok-${i}`;
    return JSON.stringify(doc);
  });
  return PREAMBLE + lines.join("\n");
}

function metadataResponse(meta: Meta): string {
  return (
    PREAMBLE +
    JSON.stringify({
      id: meta.id,
      internalDate: meta.internalDate,
      snippet: meta.snippet ?? "",
      payload: {
        headers: [
          { name: "From", value: meta.from ?? "" },
          { name: "Subject", value: meta.subject ?? "" },
          { name: "Date", value: meta.date ?? "" }
        ]
      }
    })
  );
}

function getArgId(joined: string): string | undefined {
  return joined.match(/"id":"([^"]+)"/)?.[1];
}

// gws spawn stub from a flat list response + a metadata map.
function stubSpawn(ids: string[], metaById: Record<string, Meta>): GwsSpawn {
  return async (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("messages list")) return listResponse(ids);
    if (joined.includes("messages get")) {
      const hit = getArgId(joined);
      return hit && metaById[hit] ? metadataResponse(metaById[hit]) : PREAMBLE + "{}";
    }
    return PREAMBLE + "{}";
  };
}

// A gws spawn that HONORS the `after:<epochSec>` bound the engine builds (the
// real Gmail contract). When `truncated` is set the last page carries a
// nextPageToken (page-cap-hit) and only the newest `pageCap` messages list.
function afterHonoringSpawn(
  corpus: Meta[],
  opts: { truncated?: boolean; pageCap?: number } = {}
): GwsSpawn {
  const pageCap = opts.pageCap ?? 1000;
  const byId: Record<string, Meta> = {};
  for (const m of corpus) byId[m.id] = m;
  return async (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("messages list")) {
      const afterSec = Number(joined.match(/after:(\d+)/)?.[1] ?? "0");
      const matched = corpus
        .filter((m) => Math.floor(Number(m.internalDate) / 1000) > afterSec)
        .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
      const listed = opts.truncated ? matched.slice(0, pageCap) : matched;
      const pages: string[][] = [];
      if (opts.truncated && listed.length > 0) {
        const per = Math.ceil(listed.length / 10);
        for (let i = 0; i < 10; i++) pages.push(listed.slice(i * per, (i + 1) * per).map((m) => m.id));
      } else {
        for (let i = 0; i < listed.length; i += 100) pages.push(listed.slice(i, i + 100).map((m) => m.id));
      }
      if (pages.length === 0) pages.push([]);
      return pagedListResponse(pages, opts.truncated);
    }
    if (joined.includes("messages get")) {
      const hit = getArgId(joined);
      return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
    }
    return PREAMBLE + "{}";
  };
}

function matchCount(items: { text: string; untrusted: boolean }[] | undefined): number {
  return (items ?? []).filter((i) => i.untrusted).length;
}

function draftedIds(items: { text: string }[] | undefined): string[] {
  return (items ?? []).map((i) => JSON.parse(i.text).id as string);
}

describe("parse + safety helpers", () => {
  test("parseGwsAuthStatus reads token_valid", () => {
    expect(parseGwsAuthStatus(PREAMBLE + '{"token_valid":true}').signedIn).toBe(true);
    expect(parseGwsAuthStatus(PREAMBLE + '{"token_valid":false}').signedIn).toBe(false);
    expect(parseGwsAuthStatus("garbage").signedIn).toBe(false);
  });

  test("safety floor drops automated senders", () => {
    expect(shouldDropMessage({ id: "x", from: "no-reply@service.com" })).toBe(true);
    expect(shouldDropMessage({ id: "x", from: "mailer-daemon@x.com" })).toBe(true);
    expect(shouldDropMessage({ id: "x", from: "notifications@github.com" })).toBe(true);
  });

  test("safety floor drops self by equality, not substring", () => {
    expect(shouldDropMessage({ id: "x", from: "Me <me@example.com>" }, "me@example.com")).toBe(true);
    expect(shouldDropMessage({ id: "x", from: "me@example.com" }, "me@example.com")).toBe(true);
    // self j@gmail.com must NOT drop aj@gmail.com (substring match would).
    expect(shouldDropMessage({ id: "x", from: "AJ <aj@gmail.com>" }, "j@gmail.com")).toBe(false);
    expect(shouldDropMessage({ id: "x", from: "Alice <alice@x.com>" }, "me@example.com")).toBe(false);
  });

  test("parseFromAddress extracts the bare address from either form", () => {
    expect(parseFromAddress("Alice <alice@x.com>")).toBe("alice@x.com");
    expect(parseFromAddress("bob@y.com")).toBe("bob@y.com");
    expect(parseFromAddress("no address here")).toBeUndefined();
  });

  test("buildMatchItem emits raw fields as untrusted, no fence", () => {
    const item = buildMatchItem({ id: "m1", from: "alice@x.com", subject: "hi", snippet: "yo" });
    expect(item.untrusted).toBe(true);
    expect(item.text).not.toContain("UNTRUSTED");
    expect(item.text).not.toContain("matched-context");
    const data = JSON.parse(item.text);
    expect(data.id).toBe("m1");
    expect(data.subject).toBe("hi");
  });
});

describe("detect — regimes", () => {
  test("seeding baselines from the newest match, drafts nothing, records boundary seen", async () => {
    const spawn = stubSpawn(["m2", "m1"], {
      m1: { id: "m1", internalDate: "1000", from: "alice@x.com", subject: "a" },
      m2: { id: "m2", internalDate: "2000", from: "alice@x.com", subject: "b" }
    });
    const r = await detect({ query: "from:alice@x.com is:unread", state: null }, spawn, "me@example.com");
    expect(r.kind).toBe("shortCircuit");
    expect(r.state.cursor).toBe("2000");
    // Only the newest boundary id is recorded (different seconds => no sibling).
    expect(r.state.seen).toEqual(["m2"]);
  });

  test("seeding on a truncated window baselines at the newest without enumerating", async () => {
    const newest = "huge-newest";
    let getCount = 0;
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) {
        const tail = Array.from({ length: 40 }, (_, i) => [`old-${i}`]);
        return pagedListResponse([[newest], ...tail], true);
      }
      if (joined.includes("messages get")) {
        getCount += 1;
        const id = getArgId(joined)!;
        return metadataResponse({ id, internalDate: id === newest ? "8000" : "7000", from: "alice@x.com" });
      }
      return PREAMBLE + "{}";
    };
    const r = await detect({ query: "is:unread", state: null }, spawn, "me@example.com");
    expect(r.kind).toBe("shortCircuit");
    // Newest + one older-tail probe (different second) — bounded, not a full enum.
    expect(getCount).toBe(2);
    expect(r.state.cursor).toBe("8000");
    expect(r.state.seen).toEqual([newest]);
  });

  test("seeding records same-second siblings so the inclusive after: does not re-draft them", async () => {
    const corpus: Meta[] = [
      { id: "s-new", internalDate: "1780000000900", from: "Alice <alice@x.com>", subject: "newest" },
      { id: "s-sib", internalDate: "1780000000100", from: "Alice <alice@x.com>", subject: "sibling" },
      { id: "s-old", internalDate: "1779999000000", from: "Alice <alice@x.com>", subject: "old" }
    ];
    const byId: Record<string, Meta> = {};
    for (const m of corpus) byId[m.id] = m;
    // Inclusive-after stub: `after:N` lists messages whose floored second is >= N.
    const inclusiveAfter: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) {
        const m = joined.match(/after:(\d+)/);
        const afterSec = m ? Number(m[1]) : 0;
        const matched = corpus
          .filter((x) => !m || Math.floor(Number(x.internalDate) / 1000) >= afterSec)
          .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
        return listResponse(matched.map((x) => x.id));
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };

    const seed = await detect({ query: "is:unread", state: null }, inclusiveAfter, "me@example.com");
    expect(seed.kind).toBe("shortCircuit");
    expect(seed.state.cursor).toBe("1780000000900");
    expect(new Set(seed.state.seen)).toEqual(new Set(["s-new", "s-sib"]));

    // Steady fire: the same-second sibling is re-listed but in `seen` => no draft.
    const steady = await detect(
      { query: "is:unread", state: seed.state },
      inclusiveAfter,
      "me@example.com"
    );
    expect(steady.kind).toBe("shortCircuit");
  });

  test("a new human match yields exactly one item; self/automated dropped", async () => {
    const spawn = stubSpawn(["m2", "m3", "m4"], {
      m2: { id: "m2", internalDate: "3000", from: "Alice <alice@x.com>", subject: "new" },
      m3: { id: "m3", internalDate: "3100", from: "no-reply@alice.com", subject: "auto" },
      m4: { id: "m4", internalDate: "3200", from: "me@example.com", subject: "self" }
    });
    const r = await detect(
      { query: "from:alice@x.com is:unread", state: { cursor: "1000", seen: [] } },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("context");
    expect(matchCount(r.items)).toBe(1);
    expect(draftedIds(r.items)).toEqual(["m2"]);
    // Cursor advanced to the last consumed item (m4, the newest dropped).
    expect(r.state.cursor).toBe("3200");
  });

  test("bounds the query with after:<epochSec> once a cursor exists, but not on seeding", async () => {
    const listCalls: string[] = [];
    const cap: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) listCalls.push(joined);
      return PREAMBLE + "{}";
    };
    await detect({ query: "is:unread", state: null }, cap, "me@example.com");
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).not.toContain("after:");

    await detect({ query: "is:unread", state: { cursor: "3000", seen: [] } }, cap, "me@example.com");
    expect(listCalls[1]).toContain("after:3");
  });

  test("steady non-truncated window of 30 drafts all 30 exactly once across fires, honoring after:", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `b${i}`);
    const corpus: Meta[] = ids.map((id, i) => ({
      id,
      internalDate: String(11_000_000 + i * 1000),
      from: "Alice <alice@x.com>",
      subject: `m${i}`
    }));
    const spawn = afterHonoringSpawn(corpus);

    // Fire 1: caps at MAX_MESSAGES_PER_TICK (25), oldest-first (b0..b24).
    const r1 = await detect({ query: "is:unread", state: { cursor: "1000", seen: [] } }, spawn, "me@example.com");
    expect(matchCount(r1.items)).toBe(25);
    expect(draftedIds(r1.items)).toEqual(ids.slice(0, 25));
    expect(r1.state.cursor).toBe(String(11_000_000 + 24 * 1000));

    // Fire 2 (using fire-1's state): `after:` excludes b0..b24; the last 5 drain.
    const r2 = await detect({ query: "is:unread", state: r1.state }, spawn, "me@example.com");
    expect(matchCount(r2.items)).toBe(5);
    expect(draftedIds(r2.items)).toEqual(ids.slice(25));

    // Fire 3: nothing new => shortCircuit.
    const r3 = await detect({ query: "is:unread", state: r2.state }, spawn, "me@example.com");
    expect(r3.kind).toBe("shortCircuit");
  });

  test("steady truncated window jumps cursor to newest, short-circuits with a backlog notice, no re-loop", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `c${i}`);
    const corpus: Meta[] = ids.map((id, i) => ({
      id,
      internalDate: String(12_000_000 + i * 1000),
      from: "Alice <alice@x.com>",
      subject: `t${i}`
    }));
    const spawn = afterHonoringSpawn(corpus, { truncated: true, pageCap: 10 });

    const r1 = await detect({ query: "is:unread", state: { cursor: "1000", seen: [] } }, spawn, "me@example.com");
    // No per-message drafts; a non-silent backlog summary; cursor jumped to newest.
    expect(r1.kind).toBe("shortCircuit");
    expect(matchCount(r1.items)).toBe(0);
    expect(r1.summary).toContain("backlog");
    expect(r1.summary).not.toBe("[SILENT]");
    expect(r1.state.cursor).toBe(String(12_000_000 + 59 * 1000));

    // Fire 2 (using fire-1's state): `after:` excludes the backlog => silent.
    const r2 = await detect({ query: "is:unread", state: r1.state }, spawn, "me@example.com");
    expect(r2.kind).toBe("shortCircuit");
    expect(r2.summary).toBe("[SILENT]");
  });

  test("truncated window with a bad newest metadata-get still advances the cursor", async () => {
    const newestId = "stuck-newest";
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) {
        const tail = Array.from({ length: 20 }, (_, i) => [`s${i}`]);
        return pagedListResponse([[newestId], ...tail], true);
      }
      if (joined.includes("messages get")) return PREAMBLE + "{}"; // no internalDate
      return PREAMBLE + "{}";
    };
    const r = await detect({ query: "is:unread", state: { cursor: "1000", seen: [] } }, spawn, "me@example.com");
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).toContain("backlog");
    expect(Number(r.state.cursor)).toBeGreaterThan(1000);
  });

  test("dedup: an already-seen boundary id does not re-trigger", async () => {
    // m9 sits at the cursor's boundary second and is already in `seen`.
    const spawn = stubSpawn(["m9"], {
      m9: { id: "m9", internalDate: "5000", from: "alice@x.com", subject: "old" }
    });
    const r = await detect(
      { query: "is:unread", state: { cursor: "5000", seen: ["m9"] } },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("shortCircuit");
  });
});

describe("detect — at-least-once boundary", () => {
  test("the context state is returned but the caller persists it only after dispatch", async () => {
    // The engine returns the advanced cursor on a context result; the consumer
    // persists it ONLY after dispatch. Re-running with the OLD state (a skipped
    // commit) re-detects the same match — at-least-once across delivery.
    const spawn = stubSpawn(["d1"], {
      d1: { id: "d1", internalDate: "6000", from: "Alice <alice@x.com>", subject: "hi" }
    });
    const oldState = { cursor: "1000", seen: [] as string[] };
    const r1 = await detect({ query: "is:unread", state: oldState }, spawn, "me@example.com");
    expect(matchCount(r1.items)).toBe(1);
    expect(r1.state.cursor).toBe("6000");

    // Commit skipped (dispatch threw) => re-run with oldState => re-detects d1.
    const r2 = await detect({ query: "is:unread", state: oldState }, spawn, "me@example.com");
    expect(matchCount(r2.items)).toBe(1);
    expect(draftedIds(r2.items)).toEqual(["d1"]);
  });
});
