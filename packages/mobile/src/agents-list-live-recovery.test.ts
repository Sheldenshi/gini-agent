// Live recovery check for the agents-list infinite-spinner fix, driven
// end-to-end through a REAL QueryObserver configured like app/_layout.tsx,
// the REAL api() fetcher, and a REAL Bun.serve socket that flushes response
// headers and then stalls the body forever (a genuine half-dead socket, not a
// mocked promise).
//
// The distinguishing scenario from the existing #396 test: here the runtime's
// fetch IGNORES the abort signal. The existing test relies on Bun's fetch
// honoring controller.abort() to settle the request; this one strips the
// signal before the real fetch sees it, modelling Expo winter-fetch's native
// request.cancel() that does not unblock a wedged socket on device. Under that
// condition the query must STILL leave its loading state and settle into
// error — i.e. the channels.tsx spinner clears and the Retry path appears —
// proving recovery comes from api()'s own deadline, not from the fetch
// honoring abort.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

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
const { QueryClient, QueryObserver } = await import("@tanstack/react-query");

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const realFetch = globalThis.fetch;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/agents") {
        // Headers flush immediately (200), the body stream never enqueues and
        // never closes — the socket stays open with no bytes flowing back.
        const body = new ReadableStream({
          start() {
            /* intentionally never enqueue or close */
          }
        });
        return new Response(body, { headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await server.stop(true);
  await clearCredentials();
});

beforeEach(async () => {
  await saveCredentials({ baseUrl, token: "live-token" });
});

interface ObserverLike {
  getCurrentResult(): { isLoading: boolean; status: string; error: unknown };
  subscribe(listener: () => void): () => void;
}

function waitForSettleOrTimeout(
  observer: ObserverLike,
  budgetMs: number
): Promise<{ settled: boolean; status: string; error: unknown }> {
  const { promise, resolve } = Promise.withResolvers<{
    settled: boolean;
    status: string;
    error: unknown;
  }>();
  let done = false;
  let unsubscribe: (() => void) | undefined;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (settled: boolean) => {
    if (done) return;
    done = true;
    unsubscribe?.();
    if (budgetTimer) clearTimeout(budgetTimer);
    const r = observer.getCurrentResult();
    resolve({ settled, status: r.status, error: r.error });
  };
  const check = () => {
    if (!observer.getCurrentResult().isLoading) finish(true);
  };
  unsubscribe = observer.subscribe(check);
  budgetTimer = setTimeout(() => finish(false), budgetMs);
  check();
  return promise;
}

function makeAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnMount: false, refetchOnWindowFocus: false, retry: 1 }
    }
  });
}

describe("agents-list live recovery against a real wedged socket whose abort is ignored", () => {
  test(
    "useAgents settles into ERROR (spinner clears) even though the fetch ignores abort",
    async () => {
      // Strip the abort signal before the real Bun fetch sees it, so
      // controller.abort() can't free the read — the device winter-fetch
      // native-cancel-on-a-wedged-socket condition. Recovery must therefore
      // come from api()'s own deadline race, not the fetch honoring abort.
      globalThis.fetch = ((url: string, init?: RequestInit) => {
        const stripped = { ...(init ?? {}) };
        delete (stripped as { signal?: unknown }).signal;
        return realFetch(url, stripped as RequestInit);
      }) as typeof fetch;

      const client = makeAppQueryClient();
      // Mirror useAgents() exactly, but with a short timeoutMs so the test is
      // fast; the production GET path uses the same machinery at 10s.
      const observer = new QueryObserver(client, {
        queryKey: ["agents"],
        queryFn: () => api("/agents", { timeoutMs: 200 })
      });

      // Budget comfortably exceeds 200ms timeout + 1000ms retry backoff + a
      // second 200ms timeout; a recovering query is observed as settled, a
      // latched one trips the budget.
      const result = await waitForSettleOrTimeout(observer, 6_000);
      observer.destroy();
      client.clear();

      expect(result.settled).toBe(true);
      expect(result.status).toBe("error");
      expect(result.error).toBeInstanceOf(ApiError);
      expect((result.error as InstanceType<typeof ApiError>).status).toBe(0);
      expect((result.error as Error).message).toContain("timed out");
    },
    15_000
  );
});
