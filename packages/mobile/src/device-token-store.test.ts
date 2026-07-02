// Unit tests for the APNs device-token cache that backs the
// X-Device-Token header. Builds a Map-backed fake `Storage` so the
// store's persistence invariants can be exercised without loading
// react-native or AsyncStorage.

import { describe, expect, test } from "bun:test";
import { createDeviceTokenStore, type Storage } from "./device-token-store";

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

const KEY = "gini.push.device-token";

describe("device-token-store", () => {
  test("prime() from empty storage leaves read() null", async () => {
    const storage = buildFakeStorage();
    const store = createDeviceTokenStore(storage);
    await store.prime();
    expect(store.read()).toBeNull();
  });

  test("cache(token) writes both in-memory and storage", async () => {
    const storage = buildFakeStorage();
    const store = createDeviceTokenStore(storage);
    await store.cache("tok-1");
    expect(store.read()).toBe("tok-1");
    expect(storage.inspect().get(KEY)).toBe("tok-1");
  });

  test("clear() removes from both storage and memory", async () => {
    const storage = buildFakeStorage();
    const store = createDeviceTokenStore(storage);
    await store.cache("tok-1");
    await store.clear();
    expect(store.read()).toBeNull();
    expect(storage.inspect().has(KEY)).toBe(false);
  });

  test("a fresh store primed from previously-cached storage rehydrates read()", async () => {
    // First instance writes.
    const storage = buildFakeStorage();
    const writer = createDeviceTokenStore(storage);
    await writer.cache("persisted-token");

    // Second instance — simulating a cold launch — primes from the
    // same backing storage and must observe the persisted value via
    // its synchronous reader before any registration runs.
    const reader = createDeviceTokenStore(storage);
    expect(reader.read()).toBeNull(); // not yet primed
    await reader.prime();
    expect(reader.read()).toBe("persisted-token");
  });

  test("cache(null) is equivalent to clear()", async () => {
    const storage = buildFakeStorage();
    const store = createDeviceTokenStore(storage);
    await store.cache("tok-1");
    await store.cache(null);
    expect(store.read()).toBeNull();
    expect(storage.inspect().has(KEY)).toBe(false);
  });

  test("cache('') is treated as clear() — empty strings are not a valid token", async () => {
    const storage = buildFakeStorage();
    const store = createDeviceTokenStore(storage);
    await store.cache("tok-1");
    await store.cache("");
    expect(store.read()).toBeNull();
    expect(storage.inspect().has(KEY)).toBe(false);
  });

  test("prime() is idempotent — a populated cache is not re-read from storage", async () => {
    // Seed storage with one value, then mutate it under the store's
    // feet after the first prime. A second prime must not re-read.
    const storage = buildFakeStorage({ [KEY]: "first" });
    const store = createDeviceTokenStore(storage);
    await store.prime();
    expect(store.read()).toBe("first");

    // Mutate storage out-of-band.
    await storage.setItem(KEY, "second");
    await store.prime();
    expect(store.read()).toBe("first"); // unchanged
  });

  test("custom storage key is honoured", async () => {
    const storage = buildFakeStorage();
    const store = createDeviceTokenStore(storage, "custom.key");
    await store.cache("tok-1");
    expect(storage.inspect().get("custom.key")).toBe("tok-1");
    expect(storage.inspect().has(KEY)).toBe(false);
  });

  test("concurrent cache() calls leave the store consistent — last writer wins, in-memory matches storage at quiescence", async () => {
    const storage = buildFakeStorage();
    const store = createDeviceTokenStore(storage);

    // Fire many cache() calls in parallel. The last one to settle
    // wins both in-memory and in storage. We don't care which order
    // the awaits resolve in — only that at quiescence, read() and
    // storage agree.
    const tokens = ["a", "b", "c", "d", "e", "f", "g"];
    await Promise.all(tokens.map((t) => store.cache(t)));

    const final = store.read();
    expect(final).not.toBeNull();
    expect(tokens).toContain(final!);
    expect(storage.inspect().get(KEY)).toBe(final!);
  });

  test("a storage adapter that rejects on setItem does not corrupt the in-memory slot", async () => {
    // The store swallows setItem failures so the in-memory slot
    // still covers the current process lifetime.
    const rejectingStorage: Storage = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error("storage offline");
      },
      removeItem: async () => {
        // no-op
      }
    };
    const store = createDeviceTokenStore(rejectingStorage);
    await store.cache("tok-1");
    expect(store.read()).toBe("tok-1");
  });

  test("a storage adapter that rejects on getItem leaves the cache null", async () => {
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
    const store = createDeviceTokenStore(rejectingStorage);
    await store.prime();
    expect(store.read()).toBeNull();
  });
});
