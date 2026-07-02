// Reproduction of the agents-list infinite spinner that SURVIVES the issue
// #396 / PR #415 timeout fix.
//
// PR #415 added a timeout timer to api() that calls controller.abort() and
// keeps the timer armed across the body read. That fix is correct ONLY if
// aborting the AbortController actually REJECTS the awaited fetch() (and the
// awaited response.text()). The #396 test exercises this under Bun's global
// fetch, which honors AbortController — so it settles and the test passes.
//
// On device the app does NOT run Bun's fetch. Expo SDK 56 installs the
// winter-fetch polyfill, where an abort is translated into a native
// request.cancel() on a NativeRequest SharedObject (see
// expo/src/winter/fetch/fetch.ts:80-82, NativeRequest.ts). When the
// underlying socket is wedged — the exact "zombie tunnel" condition where the
// relay keeps the TCP/HTTP connection open but no bytes ever flow back
// (frpc's loginFailExit:false never exits, so the gateway keeps advertising a
// dead URL) — cancel() does not necessarily unblock the in-flight native
// read. The timer fires, didTimeout flips true, but `await fetch(...)` /
// `await response.text()` never settles, so api()'s promise never settles,
// useAgents() stays `pending`, and channels.tsx renders its ActivityIndicator
// forever. The user force-quits — exactly the bug report ("Just hangs. Have to
// close app then relaunch.").
//
// These tests model that device-only behavior by replacing globalThis.fetch
// with stubs that IGNORE the abort signal and never settle, in two shapes:
//   1. fetch() itself never resolves and ignores abort (connection wedged
//      before headers).
//   2. fetch() resolves with headers, but response.text() never resolves and
//      ignores abort (winter fetch's lazy body stream stalls — the case the
//      api.ts comment explicitly calls out).
// Both must surface a settled rejection from api() within a tight budget. The
// invariant: api() settles on its OWN timer, never depending on the runtime's
// fetch honoring abort.

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// In-memory AsyncStorage so saveCredentials()/readCachedCredentials() work
// without the native module (mirrors agents-list-timeout.test.ts).
const memStore = new Map<string, string>();
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (k: string) => Promise.resolve(memStore.get(k) ?? null),
    setItem: (k: string, v: string) => {
      memStore.set(k, v);
      return Promise.resolve();
    },
    removeItem: (k: string) => {
      memStore.delete(k);
      return Promise.resolve();
    }
  }
}));

mock.module("expo-file-system/legacy", () => ({
  uploadAsync: () => Promise.resolve({ status: 200, body: "{}" }),
  FileSystemUploadType: { MULTIPART: "multipart" }
}));

const { api, ApiError } = await import("@/src/api");
const { saveCredentials, clearCredentials } = await import("@/src/auth");

// 127.0.0.1 is in the local-network allowlist, so http:// passes
// assertTransportAllowed without needing a real listening server — these
// tests never let the request reach the network; the stubbed fetch stands in.
const baseUrl = "http://127.0.0.1:7780";

const realFetch = globalThis.fetch;

beforeEach(async () => {
  await saveCredentials({ baseUrl, token: "test-token" });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await clearCredentials();
});

// Resolve to "rejected" only if api() actually settles; a hang surfaces as
// an explicit "hung" outcome within the test rather than the runner's
// per-test wall-clock kill, so the failure reads as the latched spinner it is.
async function raceApiAgainstHang(
  call: Promise<unknown>,
  guardMs: number
): Promise<{ outcome: "resolved" | "rejected" | "hung"; error?: unknown }> {
  const settled = call.then(
    () => ({ outcome: "resolved" as const }),
    (error) => ({ outcome: "rejected" as const, error })
  );
  const guard = new Promise<{ outcome: "hung" }>((resolve) =>
    setTimeout(() => resolve({ outcome: "hung" }), guardMs)
  );
  return Promise.race([settled, guard]);
}

describe("api() settles even when the runtime's fetch ignores abort (device winter-fetch wedge)", () => {
  test(
    "a fetch() that never resolves and ignores its abort signal still rejects via api()'s own timer",
    async () => {
      // Models the connection wedged before headers: the abort listener is
      // attached but never honored, and the promise never settles.
      globalThis.fetch = ((_url: string, _init?: RequestInit) => {
        return new Promise<Response>(() => {
          // Intentionally never resolve, and intentionally ignore _init.signal —
          // a wedged native request whose cancel() is a no-op.
        });
      }) as typeof fetch;

      const result = await raceApiAgainstHang(api("/agents", { timeoutMs: 150 }), 3_000);

      expect(result.outcome).toBe("rejected");
      expect(result.error).toBeInstanceOf(ApiError);
      expect((result.error as InstanceType<typeof ApiError>).status).toBe(0);
      expect((result.error as Error).message).toContain("timed out");
    },
    10_000
  );

  test(
    "headers arrive but response.text() never resolves and ignores abort — api() still rejects",
    async () => {
      // Models winter fetch's lazy body stream stalling: fetch() resolves with
      // a Response (headers flushed), but reading the body hangs forever and
      // the abort never interrupts it. This is the case the api.ts comment
      // calls out ("flushes headers then stalls the body").
      globalThis.fetch = ((_url: string, _init?: RequestInit) => {
        const stalledResponse = {
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>(() => {
              // never resolves; ignores abort
            })
        } as unknown as Response;
        return Promise.resolve(stalledResponse);
      }) as typeof fetch;

      const result = await raceApiAgainstHang(api("/agents", { timeoutMs: 150 }), 3_000);

      expect(result.outcome).toBe("rejected");
      expect(result.error).toBeInstanceOf(ApiError);
      expect((result.error as InstanceType<typeof ApiError>).status).toBe(0);
      expect((result.error as Error).message).toContain("timed out");
    },
    10_000
  );

  test(
    "a caller abort settles api() even when the fetch ignores the abort signal",
    async () => {
      // The caller-signal cancellation path has the same exposure as the
      // timeout path: api() races the request against a deadline, and on a
      // runtime whose fetch ignores abort the request never settles. The
      // caller-abort handler must therefore settle the race itself — not rely
      // on the fetch rejecting — or a caller that cancels mid-flight on a
      // wedged socket would hang exactly like the un-fixed spinner. With a
      // large timeoutMs the internal timer can't be what rescues this; only
      // the caller-abort settling the deadline can.
      globalThis.fetch = ((_url: string, _init?: RequestInit) => {
        return new Promise<Response>(() => {
          // never resolves; ignores _init.signal
        });
      }) as typeof fetch;

      const controller = new AbortController();
      const pending = raceApiAgainstHang(
        api("/agents", { signal: controller.signal, timeoutMs: 60_000 }),
        3_000
      );
      controller.abort();
      const result = await pending;

      expect(result.outcome).toBe("rejected");
      // A caller cancel is NOT a timeout: it must surface as a plain
      // cancellation error, never relabeled ApiError(0) "timed out".
      expect(result.error).not.toBeInstanceOf(ApiError);
      expect((result.error as Error).message).toContain("aborted");
    },
    10_000
  );
});
