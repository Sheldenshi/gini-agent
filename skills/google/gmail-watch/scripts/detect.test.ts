// Unit tests for the stateless gmail-watch detection engine (ADR email-watch.md).
//
// Covers the pure helpers (gws JSON / NDJSON-window / metadata parsers, the
// safety floor, the raw match item) AND the watcher-state regimes (seeding,
// dedup, truncation, oldest-first backlog drain, same-second siblings, the
// after: watermark bound) by calling `detect` directly with an injected gws
// spawn — no child process, no state store (the engine is pure: state in, state
// out). Every detection-hardening invariant is pinned here.

import { describe, expect, test } from "bun:test";
import {
  buildMatchItem,
  detect,
  parseFromAddress,
  parseGwsAuthStatus,
  run,
  runWatches,
  scrubError,
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

// Each item's text is "New email from <sender> — <json>"; parse the embedded
// JSON payload (everything after the first " — ").
function itemPayload(text: string): Record<string, unknown> {
  const json = text.slice(text.indexOf(" — ") + 3);
  return JSON.parse(json) as Record<string, unknown>;
}

function draftedIds(items: { text: string }[] | undefined): string[] {
  return (items ?? []).map((i) => itemPayload(i.text).id as string);
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

  test("buildMatchItem emits a sender-labeled raw item, untrusted, no fence", () => {
    const item = buildMatchItem({ id: "m1", from: "alice@x.com", subject: "hi", snippet: "yo" });
    expect(item.untrusted).toBe(true);
    expect(item.text).not.toContain("UNTRUSTED");
    expect(item.text).not.toContain("matched-context");
    // Labeled by sender so the shared thread can attribute each match.
    expect(item.text.startsWith("New email from alice@x.com — ")).toBe(true);
    const data = itemPayload(item.text);
    expect(data.id).toBe("m1");
    expect(data.subject).toBe("hi");
    expect(data.from).toBe("alice@x.com");
  });

  test("scrubError redacts secret-file paths, home-rooted paths, and /root", () => {
    expect(scrubError("failed to read /Users/alice/.config/gws/token.json")).toBe("failed to read <path>");
    // Extension-less home path is redacted too.
    expect(scrubError("keyring at /Users/x/.config/gws/keyring missing")).toBe("keyring at <path> missing");
    expect(scrubError("open /home/bob/.gini/secrets.enc: denied")).toBe("open <path>: denied");
    expect(scrubError("config /root/.config/gws failed")).toBe("config <path> failed");
    // /root anchored so it doesn't eat /rootcause.
    expect(scrubError("the rootcause was unclear")).toBe("the rootcause was unclear");
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

  test("a healthy tick stamps status:ok into the returned state", async () => {
    const spawn = stubSpawn(["m2", "m1"], {
      m1: { id: "m1", internalDate: "1000", from: "alice@x.com", subject: "a" },
      m2: { id: "m2", internalDate: "2000", from: "alice@x.com", subject: "b" }
    });
    // Seeding tick.
    const seed = await detect({ query: "is:unread", state: null }, spawn, "me@example.com");
    expect(seed.state.status).toBe("ok");
    // Steady tick with a new match.
    const steady = await detect(
      { query: "is:unread", state: { cursor: "1000", seen: [] } },
      stubSpawn(["m3"], { m3: { id: "m3", internalDate: "3000", from: "Bob <bob@x.com>", subject: "hi" } }),
      "me@example.com"
    );
    expect(steady.kind).toBe("context");
    expect(steady.state.status).toBe("ok");
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

describe("run — health in state", () => {
  test("signed-out tick emits status:needs_auth with cursor/seen unchanged", async () => {
    const signedOut: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":false}';
      throw new Error("should not poll while signed out");
    };
    const r = await run({ query: "is:unread", state: { cursor: "5000", seen: ["m1"] } }, signedOut);
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).toBe("[SILENT]");
    expect(r.state.status).toBe("needs_auth");
    // Cursor/seen carried through unchanged (don't advance past unread mail).
    expect(r.state.cursor).toBe("5000");
    expect(r.state.seen).toEqual(["m1"]);
    expect(r.state.lastError).toBeUndefined();
  });

  test("gws-error tick emits status:error + a scrubbed lastError, cursor/seen unchanged", async () => {
    const erroring: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      throw new Error("transport blew up reading /Users/alice/.config/gws/token.json");
    };
    const r = await run({ query: "is:unread", state: { cursor: "7000", seen: ["m2"] } }, erroring);
    expect(r.kind).toBe("shortCircuit");
    expect(r.state.status).toBe("error");
    expect(r.state.lastError).toBe("transport blew up reading <path>");
    expect(r.state.cursor).toBe("7000");
    expect(r.state.seen).toEqual(["m2"]);
  });

  test("a healthy signed-in tick returns detect's status:ok result", async () => {
    const healthy: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) return listResponse(["m2", "m1"]);
      return PREAMBLE + "{}";
    };
    const r = await run({ query: "is:unread", state: null }, healthy);
    expect(r.kind).toBe("shortCircuit"); // seeding
    expect(r.state.status).toBe("ok");
    expect(r.state.lastError).toBeUndefined();
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

describe("runWatches — multi-watch (one shared job)", () => {
  // Extract the `q:"..."` value from a `messages list` args line so a stub can
  // route per-watch by query (each watch lists under its own query).
  function listQuery(joined: string): string | undefined {
    return joined.match(/"q":"([^"]*)"/)?.[1];
  }

  // gws spawn routing list/get per-query: each query maps to a flat id list +
  // shared metadata map. signedIn is true; getProfile resolves the self address.
  function multiSpawn(
    byQuery: Record<string, string[]>,
    metaById: Record<string, Meta>,
    self = "me@example.com"
  ): GwsSpawn {
    return async (args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + JSON.stringify({ emailAddress: self });
      if (joined.includes("messages list")) {
        const q = listQuery(joined) ?? "";
        // Honor any after:<sec> the engine appended to the watch's base query.
        const base = q.replace(/ after:\d+$/, "");
        return listResponse(byQuery[base] ?? byQuery[q] ?? []);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit && metaById[hit] ? metadataResponse(metaById[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
  }

  test("iterates watches with per-watch state, drafts across senders in one turn", async () => {
    const spawn = multiSpawn(
      {
        "from:alice@x.com is:unread": ["a1"],
        "from:bob@x.com is:unread": ["b1"]
      },
      {
        a1: { id: "a1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "from alice" },
        b1: { id: "b1", internalDate: "4000", from: "Bob <bob@x.com>", subject: "from bob" }
      }
    );
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-alice", query: "from:alice@x.com is:unread" },
          { watcherId: "w-bob", query: "from:bob@x.com is:unread" }
        ],
        state: { byWatcher: { "w-alice": { cursor: "1000", seen: [] }, "w-bob": { cursor: "1000", seen: [] } } }
      },
      spawn
    );
    // ONE drafting turn carries BOTH senders' matches, each labeled by sender.
    expect(r.kind).toBe("context");
    expect(matchCount(r.items)).toBe(2);
    expect(r.items!.some((i) => i.text.startsWith("New email from Alice <alice@x.com> — "))).toBe(true);
    expect(r.items!.some((i) => i.text.startsWith("New email from Bob <bob@x.com> — "))).toBe(true);
    // Per-watch state advanced independently.
    expect(r.state.byWatcher["w-alice"]!.cursor).toBe("3000");
    expect(r.state.byWatcher["w-bob"]!.cursor).toBe("4000");
    expect(r.state.byWatcher["w-alice"]!.status).toBe("ok");
    expect(r.state.byWatcher["w-bob"]!.status).toBe("ok");
  });

  test("a per-watch gws error isolates to that watch; the others still draft", async () => {
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = listQuery(joined) ?? "";
        // The "bad" watch's list throws; the "good" watch lists a match.
        if (q.startsWith("from:bad@x.com")) {
          throw new Error("transport blew up reading /Users/alice/.config/gws/token.json");
        }
        return listResponse(["g1"]);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit === "g1"
          ? metadataResponse({ id: "g1", internalDate: "5000", from: "Good <good@x.com>", subject: "ok" })
          : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-bad", query: "from:bad@x.com is:unread" },
          { watcherId: "w-good", query: "from:good@x.com is:unread" }
        ],
        state: { byWatcher: { "w-bad": { cursor: "1000", seen: [] }, "w-good": { cursor: "1000", seen: [] } } }
      },
      spawn
    );
    // The good watch still drafts; the bad watch is marked error with a SCRUBBED
    // lastError and its cursor unchanged.
    expect(r.kind).toBe("context");
    expect(matchCount(r.items)).toBe(1);
    expect(draftedIds(r.items)).toEqual(["g1"]);
    expect(r.state.byWatcher["w-good"]!.status).toBe("ok");
    expect(r.state.byWatcher["w-good"]!.cursor).toBe("5000");
    expect(r.state.byWatcher["w-bad"]!.status).toBe("error");
    expect(r.state.byWatcher["w-bad"]!.lastError).toBe("transport blew up reading <path>");
    expect(r.state.byWatcher["w-bad"]!.cursor).toBe("1000");
  });

  test("signed-out marks every watch needs_auth, no model turn, cursors unchanged", async () => {
    const signedOut: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":false}';
      throw new Error("should not poll while signed out");
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w1", query: "from:a@x.com is:unread" },
          { watcherId: "w2", query: "from:b@x.com is:unread" }
        ],
        state: { byWatcher: { w1: { cursor: "1000", seen: ["x"] }, w2: { cursor: "2000", seen: [] } } }
      },
      signedOut
    );
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).toBe("[SILENT]");
    expect(r.state.byWatcher.w1!.status).toBe("needs_auth");
    expect(r.state.byWatcher.w2!.status).toBe("needs_auth");
    // Cursors/seen carried through unchanged (don't advance past unread mail).
    expect(r.state.byWatcher.w1!.cursor).toBe("1000");
    expect(r.state.byWatcher.w1!.seen).toEqual(["x"]);
    expect(r.state.byWatcher.w2!.cursor).toBe("2000");
  });

  test("seeding a fresh watch (no per-watch state) baselines without drafting", async () => {
    const spawn = multiSpawn(
      { "from:new@x.com is:unread": ["n1"] },
      { n1: { id: "n1", internalDate: "9000", from: "New <new@x.com>", subject: "hi" } }
    );
    const r = await runWatches(
      { watches: [{ watcherId: "w-new", query: "from:new@x.com is:unread" }], state: null },
      spawn
    );
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).toBe("[SILENT]");
    // Baselined at the newest, drafted nothing, recorded the boundary id.
    expect(r.state.byWatcher["w-new"]!.cursor).toBe("9000");
    expect(r.state.byWatcher["w-new"]!.seen).toEqual(["n1"]);
    expect(r.state.byWatcher["w-new"]!.status).toBe("ok");
  });

  test("per-watch backlog notices join into one non-silent shortCircuit summary", async () => {
    // Two watches both hit truncated windows (no draftable match); their notices
    // join into one summary so the shared thread surfaces both.
    const corpusA: Meta[] = Array.from({ length: 60 }, (_, i) => ({
      id: `a${i}`,
      internalDate: String(12_000_000 + i * 1000),
      from: "Alice <alice@x.com>",
      subject: `a${i}`
    }));
    const corpusB: Meta[] = Array.from({ length: 60 }, (_, i) => ({
      id: `b${i}`,
      internalDate: String(13_000_000 + i * 1000),
      from: "Bob <bob@x.com>",
      subject: `b${i}`
    }));
    const byId: Record<string, Meta> = {};
    for (const m of [...corpusA, ...corpusB]) byId[m.id] = m;
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = listQuery(joined) ?? "";
        const corpus = q.startsWith("from:alice") ? corpusA : corpusB;
        const afterSec = Number(joined.match(/after:(\d+)/)?.[1] ?? "0");
        const listed = corpus
          .filter((m) => Math.floor(Number(m.internalDate) / 1000) > afterSec)
          .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
          .slice(0, 10);
        const pages: string[][] = [];
        const per = Math.ceil(listed.length / 10);
        for (let i = 0; i < 10; i++) pages.push(listed.slice(i * per, (i + 1) * per).map((m) => m.id));
        return pagedListResponse(pages, true);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-a", query: "from:alice@x.com is:unread" },
          { watcherId: "w-b", query: "from:bob@x.com is:unread" }
        ],
        state: { byWatcher: { "w-a": { cursor: "1000", seen: [] }, "w-b": { cursor: "1000", seen: [] } } }
      },
      spawn
    );
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).not.toBe("[SILENT]");
    // Both watches' backlog notices are present in the joined summary.
    expect(r.summary).toContain("from:alice@x.com is:unread");
    expect(r.summary).toContain("from:bob@x.com is:unread");
    // Both cursors jumped to their newest.
    expect(r.state.byWatcher["w-a"]!.cursor).toBe(String(12_000_000 + 59 * 1000));
    expect(r.state.byWatcher["w-b"]!.cursor).toBe(String(13_000_000 + 59 * 1000));
  });

  test("a sibling match in the same tick as a backlog carries the notice as a trusted item", async () => {
    // One watch produces a fresh draftable match; another hits a truncated
    // (page-cap) window in the SAME tick. The match makes this a context result,
    // so the backlog notice must ride along (as a TRUSTED item) instead of being
    // dropped while the truncated watch's cursor advances.
    const backlog: Meta[] = Array.from({ length: 60 }, (_, i) => ({
      id: `bk${i}`,
      internalDate: String(20_000_000 + i * 1000),
      from: "Bulk <bulk@x.com>",
      subject: `bk${i}`
    }));
    const byId: Record<string, Meta> = {
      m1: { id: "m1", internalDate: "5000", from: "Alice <alice@x.com>", subject: "fresh" }
    };
    for (const m of backlog) byId[m.id] = m;
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = listQuery(joined) ?? "";
        if (q.startsWith("from:alice")) return listResponse(["m1"]);
        // The bulk watch's window is truncated (page cap hit).
        const afterSec = Number(joined.match(/after:(\d+)/)?.[1] ?? "0");
        const listed = backlog
          .filter((m) => Math.floor(Number(m.internalDate) / 1000) > afterSec)
          .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
          .slice(0, 10);
        const pages: string[][] = [];
        const per = Math.ceil(listed.length / 10);
        for (let i = 0; i < 10; i++) pages.push(listed.slice(i * per, (i + 1) * per).map((m) => m.id));
        return pagedListResponse(pages, true);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-alice", query: "from:alice@x.com is:unread" },
          { watcherId: "w-bulk", query: "from:bulk@x.com is:unread" }
        ],
        state: { byWatcher: { "w-alice": { cursor: "1000", seen: [] }, "w-bulk": { cursor: "1000", seen: [] } } }
      },
      spawn
    );
    // The match makes it a context turn carrying BOTH the draft AND the notice.
    expect(r.kind).toBe("context");
    // Exactly one draftable (untrusted) match — Alice's fresh email.
    expect(matchCount(r.items)).toBe(1);
    expect(r.items!.some((i) => i.untrusted && i.text.startsWith("New email from Alice <alice@x.com> — "))).toBe(true);
    // The backlog notice rides along as a TRUSTED item (not dropped).
    const notice = r.items!.filter((i) => !i.untrusted);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.text).toContain("backlog");
    expect(notice[0]!.text).toContain("from:bulk@x.com is:unread");
    // The truncated watch's cursor still jumped to its newest.
    expect(r.state.byWatcher["w-bulk"]!.cursor).toBe(String(20_000_000 + 59 * 1000));
  });

  test("no watches yields a silent shortCircuit with empty byWatcher", async () => {
    const spawn = multiSpawn({}, {});
    const r = await runWatches({ watches: [], state: null }, spawn);
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).toBe("[SILENT]");
    expect(r.state.byWatcher).toEqual({});
  });
});
