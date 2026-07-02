// Pins the recovery contract for issue #396: a hung /agents request must
// not leave the agents list latched on its loading spinner.
//
// The spinner-latch condition lives in mobile/app/channels.tsx:
//
//     {agents.isLoading && agentList.length === 0 ? <ActivityIndicator/> : ...}
//
// where `agents = useAgents()` → useQuery({ queryFn: () => api("/agents") }).
// In React Query, `isLoading === isPending && isFetching`. A query is
// `pending` while it has no data AND its queryFn promise has not settled,
// and `retry: 1` (the app's QueryClient default in app/_layout.tsx) only
// fires after a REJECTION. So a queryFn promise that never settles keeps
// the query `pending` and the spinner up indefinitely; the invariant under
// test is that api() always settles the promise (here, by timing out).
//
// This drives the REAL api() fetcher through a REAL QueryObserver
// configured the way app/_layout.tsx configures the shared QueryClient
// (refetchOnMount:false, refetchOnWindowFocus:false, retry:1), against a
// Bun.serve gateway that accepts the TCP connection and then NEVER answers
// GET /api/agents, and asserts the query leaves the loading state and
// settles into an error rather than latching.
//
// The test passes a short explicit `timeoutMs` so it runs fast, but it
// exercises the same AbortController machinery the production GET default
// (GET_TIMEOUT_MS = 10_000) uses — the timeout aborts the request and api()
// surfaces ApiError(0, "…timed out"), so the query settles into `isError`.

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
// Import from the declared dependency (@tanstack/react-query) rather than
// @tanstack/query-core directly — react-query re-exports both classes as
// the identical references, and query-core is only a transitive dep that
// mobile/package.json doesn't declare.
const { QueryClient, QueryObserver } = await import("@tanstack/react-query");

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
// where it is no longer loading (success or error), OR report not-settled
// after a wall-clock budget. The budget comfortably exceeds the short
// timeoutMs the test passes, so a query that settles is observed as
// settled and one that never settles is caught as a latched-spinner
// failure rather than running to the per-test cap.
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
  // Declared before subscribe so finish() can reference them even if
  // subscribe() were to notify synchronously (the bindings are assigned
  // below; using `let` avoids a temporal-dead-zone reference if check()
  // fires during subscribe()).
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
    const r = observer.getCurrentResult();
    // isLoading === pending && fetching. Once the query is no longer loading,
    // it has either succeeded or errored — the spinner condition clears.
    if (!r.isLoading) finish(true);
  };
  unsubscribe = observer.subscribe(check);
  budgetTimer = setTimeout(() => finish(false), budgetMs);
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
      // Mirror useAgents() exactly: queryKey ["agents"], queryFn
      // () => api("/agents") with NO forwarded signal (production doesn't
      // forward React Query's signal, and the fix doesn't depend on it —
      // the internal timeout is what settles the query). The only
      // difference from production is the short timeoutMs: the production
      // GET path uses GET_TIMEOUT_MS (10_000) via the identical
      // AbortController code path; we pass 150 so the test settles in
      // 1300ms (150 + 1000 retry backoff + 150) not 10s.
      const observer = new QueryObserver(client, {
        queryKey: ["agents"],
        queryFn: () => api("/agents", { timeoutMs: 150 })
      });

      // Budget = 6000ms: comfortably longer than the 150ms timeout + the
      // single retry's fixed 1000ms backoff + a second 150ms timeout (1300ms
      // total), so a settling query is observed as settled while a
      // never-settling one trips the budget and reports settled:false.
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
      // Directly pins the fetcher-level guarantee the screen depends on:
      // the promise SETTLES (rejects) instead of staying pending.
      const { promise, resolve } = Promise.withResolvers<
        { outcome: "resolved" | "rejected"; error?: unknown }
      >();
      api("/agents", { timeoutMs: 150 }).then(
        () => resolve({ outcome: "resolved" }),
        (error) => resolve({ outcome: "rejected", error })
      );
      // Guard so a hang surfaces as an explicit assertion failure within the
      // test rather than the runner's per-test wall-clock kill.
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
afterAll(async () => {
  await clearCredentials();
});
