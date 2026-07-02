// Unit tests for the stable per-install client-id cache that backs the
// X-Gini-Client-ID header on native pairing. Builds a Map-backed fake `Storage`
// so the store's generate-once-and-persist invariant can be exercised without
// loading react-native or AsyncStorage.

import { describe, expect, test } from "bun:test";
import { createClientIdStore } from "./client-id-store";
import type { Storage } from "./device-token-store";

function buildFakeStorage(seed?: Record<string, string>): Storage & {
  inspect(): Map<string, string>;
} {
  const map = new Map<string, string>(seed ? Object.entries(seed) : []);
  return {
    getItem: async (key) => (map.has(key) ? map.get(key)! : null),
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
    inspect: () => map
  };
}

// A deterministic id generator so tests can assert exact values.
function countingGen() {
  let n = 0;
  return () => `client-${++n}`;
}

const KEY = "gini.client-id.v1";

describe("client-id-store", () => {
  test("read() is null before prime()", () => {
    const store = createClientIdStore(buildFakeStorage(), countingGen());
    expect(store.read()).toBeNull();
  });

  test("prime() on empty storage generates and persists a stable id", async () => {
    const storage = buildFakeStorage();
    const store = createClientIdStore(storage, countingGen());
    await store.prime();
    expect(store.read()).toBe("client-1");
    // The generated id is written through so the next cold launch reuses it.
    expect(storage.inspect().get(KEY)).toBe("client-1");
  });

  test("prime() rehydrates a previously-persisted id rather than minting a new one", async () => {
    const storage = buildFakeStorage({ [KEY]: "persisted-client" });
    const store = createClientIdStore(storage, countingGen());
    await store.prime();
    expect(store.read()).toBe("persisted-client");
    // The generator was never consulted.
    expect(storage.inspect().get(KEY)).toBe("persisted-client");
  });

  test("the id is stable across cold launches (second store primes the same value)", async () => {
    const storage = buildFakeStorage();
    const first = createClientIdStore(storage, countingGen());
    await first.prime();
    const minted = first.read();
    expect(minted).toBe("client-1");

    // A fresh store (cold launch) over the same backing storage rehydrates it.
    const second = createClientIdStore(storage, countingGen());
    expect(second.read()).toBeNull();
    await second.prime();
    expect(second.read()).toBe(minted);
  });

  test("prime() is idempotent — a populated slot is not regenerated or re-read", async () => {
    const storage = buildFakeStorage();
    const store = createClientIdStore(storage, countingGen());
    await store.prime();
    expect(store.read()).toBe("client-1");

    // Mutate storage out-of-band; a second prime must not re-read or regenerate.
    await storage.setItem(KEY, "tampered");
    await store.prime();
    expect(store.read()).toBe("client-1");
  });

  test("a custom storage key is honoured", async () => {
    const storage = buildFakeStorage();
    const store = createClientIdStore(storage, countingGen(), "custom.key");
    await store.prime();
    expect(storage.inspect().get("custom.key")).toBe("client-1");
    expect(storage.inspect().has(KEY)).toBe(false);
  });

  test("a getItem failure falls back to an in-memory id for this process", async () => {
    // Storage offline on read: rather than leave the slot null (which would mint
    // a new id on every call), prime generates one and keeps it in memory for the
    // process lifetime. Best-effort persistence still attempts a write.
    const rejectingStorage: Storage = {
      getItem: async () => {
        throw new Error("storage offline");
      },
      setItem: async () => {
        // no-op
      },
      removeItem: async () => {
        // no-op
      }
    };
    const store = createClientIdStore(rejectingStorage, countingGen());
    await store.prime();
    expect(store.read()).toBe("client-1");
  });

  test("a setItem failure does not corrupt the in-memory slot", async () => {
    const rejectingStorage: Storage = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error("storage offline");
      },
      removeItem: async () => {
        // no-op
      }
    };
    const store = createClientIdStore(rejectingStorage, countingGen());
    await store.prime();
    expect(store.read()).toBe("client-1");
  });

  test("clear() drops both the in-memory slot and the persisted row", async () => {
    const storage = buildFakeStorage();
    const store = createClientIdStore(storage, countingGen());
    await store.prime();
    expect(store.read()).toBe("client-1");
    await store.clear();
    expect(store.read()).toBeNull();
    expect(storage.inspect().has(KEY)).toBe(false);
    // After a clear, the next prime mints a FRESH id (the counter advances).
    await store.prime();
    expect(store.read()).toBe("client-2");
  });

  test("the default generator yields a non-empty, unique, persistable string", async () => {
    // No injected generator → exercises the real Hermes-safe idiom.
    const storage = buildFakeStorage();
    const a = createClientIdStore(storage);
    await a.prime();
    const first = a.read();
    expect(typeof first).toBe("string");
    expect(first!.length).toBeGreaterThan(8);

    await a.clear();
    await a.prime();
    const second = a.read();
    expect(second).not.toBe(first);
  });
});
