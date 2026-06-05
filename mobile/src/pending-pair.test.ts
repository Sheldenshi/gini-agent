import { describe, expect, test, mock } from "bun:test";

// AsyncStorage isn't available under bun:test — stub it with an in-memory store
// plus per-operation throw toggles so the storage-failure branches are covered.
let store: Record<string, string> = {};
let throwOnGet = false;
let throwOnSet = false;
let throwOnRemove = false;

mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => {
      if (throwOnGet) throw new Error("getItem failed");
      return store[k] ?? null;
    },
    setItem: async (k: string, v: string) => {
      if (throwOnSet) throw new Error("setItem failed");
      store[k] = v;
    },
    removeItem: async (k: string) => {
      if (throwOnRemove) throw new Error("removeItem failed");
      delete store[k];
    }
  }
}));

import {
  PENDING_PAIR_TTL_MS,
  isPendingPairLive,
  parsePendingPair,
  loadPendingPairFromStorage,
  savePendingPair,
  clearPendingPair,
  readCachedPendingPair,
  primePendingPair,
  type PendingPair
} from "./pending-pair";

const KEY = "gini.pending-pair.v1";
const reqRecord: PendingPair = {
  kind: "request",
  relayOrigin: "https://abc.gini-relay.lilaclabs.ai",
  id: "req1",
  bindSecret: "secret1",
  code: "123-456",
  createdAt: 1000
};

// Runs FIRST so primePendingPair observes cached === undefined (the cold-start
// branch). Any save/clear sets the module cache, so this can't be reordered after.
describe("primePendingPair", () => {
  test("first call loads + validates from storage (cache was undefined)", async () => {
    store[KEY] = JSON.stringify(reqRecord);
    expect(await primePendingPair()).toEqual(reqRecord);
  });

  test("later calls return the in-memory cache without touching storage", async () => {
    store[KEY] = JSON.stringify(reqRecord);
    await primePendingPair(); // prime the cache ourselves so the test is order-independent
    throwOnGet = true; // would throw if a later prime hit storage again
    expect(await primePendingPair()).toEqual(reqRecord);
    throwOnGet = false;
  });
});

describe("isPendingPairLive", () => {
  test("true when younger than the TTL", () => {
    expect(isPendingPairLive({ kind: "input", createdAt: 0 }, PENDING_PAIR_TTL_MS - 1)).toBe(true);
  });
  test("false at/after the TTL", () => {
    expect(isPendingPairLive({ kind: "input", createdAt: 0 }, PENDING_PAIR_TTL_MS)).toBe(false);
  });
});

describe("parsePendingPair", () => {
  test("null/empty -> null", () => {
    expect(parsePendingPair(null)).toBeNull();
    expect(parsePendingPair("")).toBeNull();
  });
  test("invalid JSON -> null", () => {
    expect(parsePendingPair("{not json")).toBeNull();
  });
  test("non-object JSON -> null", () => {
    expect(parsePendingPair("5")).toBeNull();
    expect(parsePendingPair("null")).toBeNull();
  });
  test("missing or non-numeric createdAt -> null", () => {
    expect(parsePendingPair(JSON.stringify({ kind: "input" }))).toBeNull();
    expect(parsePendingPair(JSON.stringify({ kind: "input", createdAt: "x" }))).toBeNull();
  });
  test("valid input record", () => {
    expect(parsePendingPair(JSON.stringify({ kind: "input", createdAt: 7 }))).toEqual({
      kind: "input",
      createdAt: 7
    });
  });
  test("valid request record", () => {
    expect(parsePendingPair(JSON.stringify(reqRecord))).toEqual(reqRecord);
  });
  test("request record missing a field -> null", () => {
    const { code: _code, ...partial } = reqRecord;
    expect(parsePendingPair(JSON.stringify(partial))).toBeNull();
  });
  test("unknown kind -> null", () => {
    expect(parsePendingPair(JSON.stringify({ kind: "nope", createdAt: 1 }))).toBeNull();
  });
});

describe("loadPendingPairFromStorage", () => {
  test("returns the parsed record on success", async () => {
    store[KEY] = JSON.stringify({ kind: "input", createdAt: 9 });
    expect(await loadPendingPairFromStorage()).toEqual({ kind: "input", createdAt: 9 });
  });
  test("returns null when storage throws", async () => {
    throwOnGet = true;
    expect(await loadPendingPairFromStorage()).toBeNull();
    throwOnGet = false;
  });
});

describe("save / clear / read", () => {
  test("save persists and caches", async () => {
    await savePendingPair(reqRecord);
    expect(readCachedPendingPair()).toEqual(reqRecord);
    expect(store[KEY]).toBe(JSON.stringify(reqRecord));
  });
  test("save still caches when storage throws", async () => {
    throwOnSet = true;
    const rec: PendingPair = { kind: "input", createdAt: 42 };
    await savePendingPair(rec);
    expect(readCachedPendingPair()).toEqual(rec);
    throwOnSet = false;
  });
  test("clear empties cache and storage", async () => {
    await savePendingPair(reqRecord);
    await clearPendingPair();
    expect(readCachedPendingPair()).toBeNull();
    expect(store[KEY]).toBeUndefined();
  });
  test("clear still empties cache when storage throws", async () => {
    await savePendingPair(reqRecord);
    throwOnRemove = true;
    await clearPendingPair();
    expect(readCachedPendingPair()).toBeNull();
    throwOnRemove = false;
  });
});
