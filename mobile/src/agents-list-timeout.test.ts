// Independent verification of the fix for issue #396:
//   "Mobile: navigating back from a chat leaves the agents list stuck on an
//    infinite loading spinner (force-quit to recover)."
//
// The spinner-latch condition lives in mobile/app/channels.tsx:
//
//     {agents.isLoading && agentList.length === 0 ? <ActivityIndicator/> : ...}
//
// where `agents = useAgents()` → useQuery({ queryFn: () => api("/agents") }).
// In React Query, `isLoading === isPending && isFetching`. A query is
// `pending` while it has no data AND its queryFn promise has not settled.
// `retry: 1` (the app's QueryClient default in app/_layout.tsx) only fires
// after a REJECTION — a fetch promise that never resolves and never rejects
// keeps the query `pending` forever, so `isLoading` stays true and the
// spinner never goes away. The only recovery pre-fix is force-quit.
//
// This test drives the REAL api() fetcher through a REAL query-core
// QueryObserver configured exactly the way app/_layout.tsx configures the
// app's shared QueryClient (refetchOnMount:false, refetchOnWindowFocus:false,
// retry:1), against a Bun.serve gateway that accepts the TCP connection and
// then NEVER answers GET /api/agents. We then assert whether the query
// eventually leaves the loading/pending state (recovers into error) or stays
// latched in loading forever.
//
// Discrimination: the test passes a short explicit `timeoutMs` to api() so
// it completes fast, but it exercises the EXACT abort machinery the
// production default (GET_TIMEOUT_MS = 10_000 for the no-timeout useAgents
// GET) relies on — same lines of api.ts. On the PRE-FIX api.ts there is no
// timeoutMs support and no AbortController at all
// (`fetch(url, { ...rest, headers })` is awaited unconditionally), so the
// request hangs and the query stays `pending` → these tests FAIL. On the
// FIXED api.ts the abort fires, api() throws ApiError(0, "…timed out"), the
// query settles into `isError` → these tests PASS.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// --- Native-module mocks (api.ts → expo-file-system/legacy, auth.ts →
//     @react-native-async-storage/async-storage). Mirrors the mocking
//     convention in mobile/src/components/NewAgentSheet.test.tsx. ---

// In-memory AsyncStorage so saveCredentials()/readCachedCredentials() work
// without the native module.
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

// api.ts only touches expo-file-system/legacy in the multipart upload path,
// which this test never exercises — a bare stub is enough to let the module
// import.
mock.module("expo-file-system/legacy", () => ({
  uploadAsync: () => Promise.resolve({ status: 200, body: "{}" }),
  FileSystemUploadType: { MULTIPART: "multipart" }
}));

const { api, ApiError } = await import("@/src/api");
const { saveCredentials, clearCredentials } = await import("@/src/auth");
const { QueryClient, QueryObserver } = await import("@tanstack/query-core");

// --- A gateway that accepts the connection but never answers /agents.
//     The promise returned by the handler never resolves, so the HTTP
//     response is held open indefinitely — exactly the "half-dead socket"
//     the issue describes (a stuck request that completes the TCP handshake
//     but produces no response). ---
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
// Resolvers for the in-flight hung requests so we can release them on
// teardown and not leak a pending fetch past the test process.
const hung: Array<() => void> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/agents") {
        // Never answer. Hold the response open until teardown.
        await new Promise<void>((resolve) => hung.push(resolve));
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }
  });
  // 127.0.0.1 is in the local-network allowlist, so http:// is permitted by
  // assertTransportAllowed / normalizeBaseUrl.
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  for (const release of hung) release();
  hung.length = 0;
  await server.stop(true);
});

beforeEach(async () => {
  await saveCredentials({ baseUrl, token: "test-token" });
});

// Subscribe to a QueryObserver and resolve once the query reaches a state
// where it is no longer loading (success or error), OR reject after a wall
// clock budget. The budget must comfortably exceed the short timeoutMs we
// pass so the FIXED code's abort has time to land, while still failing fast
// on the PRE-FIX code (which never settles).
// Structural subset of QueryObserver this helper needs. Typing it
// structurally sidesteps the variance mismatch between the concrete
// QueryObserver<…, Error, …, string[]> the observer infers and the
// fully-generic QueryObserver<…, unknown, …, readonly unknown[]> the class
// type advertises — we only ever read result fields and subscribe.
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
  const finish = (settled: boolean) => {
    if (done) return;
    done = true;
    unsubscribe();
    clearTimeout(budgetTimer);
    const r = observer.getCurrentResult();
    resolve({ settled, status: r.status, error: r.error });
  };
  const check = () => {
    const r = observer.getCurrentResult();
    // isLoading === pending && fetching. Once the query is no longer loading,
    // it has either succeeded or errored — the spinner condition clears.
    if (!r.isLoading) finish(true);
  };
  const unsubscribe = observer.subscribe(check);
  const budgetTimer = setTimeout(() => finish(false), budgetMs);
  // Evaluate the initial state too in case it's already settled.
  check();
  return promise;
}

// Build the app's QueryClient with the EXACT defaults from app/_layout.tsx.
function makeAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        retry: 1
      }
    }
  });
}

describe("issue #396 — agents-list infinite spinner on a never-answering gateway", () => {
  test(
    "useAgents query settles into ERROR (does not latch on loading) when /agents never responds",
    async () => {
      const client = makeAppQueryClient();
      // This mirrors useAgents() exactly: queryKey ["agents"], queryFn
      // () => api("/agents"). The only difference from production is the
      // short timeoutMs — the production GET path uses GET_TIMEOUT_MS
      // (10_000) via the identical AbortController code path. We pass it
      // explicitly so the test settles in 1300ms (150 + 1000 retry backoff
      // + 150) not 10s.
      const observer = new QueryObserver(client, {
        queryKey: ["agents"],
        queryFn: ({ signal }) => api("/agents", { timeoutMs: 150, signal })
      });

      // Budget = 6000ms: comfortably longer than the 150ms timeout + the
      // single retry's fixed 1000ms backoff + a second 150ms timeout (1300ms
      // total) so the FIXED code definitely settles, yet short enough that
      // the PRE-FIX code (which hangs forever) trips the budget and reports
      // settled:false.
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

  test(
    "a bare api('/agents') call against a hung gateway rejects rather than hanging forever",
    async () => {
      // Directly proves the fetcher-level guarantee the screen depends on:
      // the promise SETTLES (rejects) instead of staying pending. On pre-fix
      // code this await never returns and the test trips its own 15s cap.
      const { promise, resolve } = Promise.withResolvers<
        { outcome: "resolved" | "rejected"; error?: unknown }
      >();
      api("/agents", { timeoutMs: 150 }).then(
        () => resolve({ outcome: "resolved" }),
        (error) => resolve({ outcome: "rejected", error })
      );
      // Guard so a hang (pre-fix) surfaces as an explicit assertion failure
      // within the test rather than the runner's per-test wall-clock kill.
      const guard = new Promise<{ outcome: "hung" }>((r) =>
        setTimeout(() => r({ outcome: "hung" }), 3_000)
      );
      const settled = await Promise.race([promise, guard]);

      expect(settled.outcome).toBe("rejected");
      expect((settled as { error: unknown }).error).toBeInstanceOf(ApiError);
    },
    15_000
  );
});

// Sanity: the production useAgents path relies on the method-derived
// default timeout (no per-call timeoutMs). This documents that the same
// abort machine the tests above drive with timeoutMs:150 is what fires at
// GET_TIMEOUT_MS (10s) for the real /agents GET in prod.
afterAll(() => {
  void clearCredentials();
});
