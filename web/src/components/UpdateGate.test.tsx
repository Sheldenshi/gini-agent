/// <reference lib="dom" />

// UpdateGate phase machine. The hazard pinned here: POST /update applies the
// new revision on disk in the OLD gateway process, so /status reports the new
// sha while both servers are about to restart — and because the gateway and
// web server bounce independently, a status poll can reach the NEW gateway
// through the still-alive OLD web server. Reloading on the sha or the gateway
// pid alone lands the browser on a dead web server. The gate must hold in
// "restarting" until BOTH processes prove they restarted: a new gateway pid
// from /status AND a new web pid from the local __healthz route — or, for a
// leg whose starting pid is unknown, the first poll on that query that
// succeeds after entering the phase.
//
// LEAK SAFETY: no module mocks — global fetch, window.location.reload and
// sessionStorage are stubbed/cleared per test and restored in afterEach.

import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, setSystemTime, test } from "bun:test";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { defaultScheduler, notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UpdateGateProvider, useUpdateGate } from "./UpdateGate";
import type { GiniUpdateResult, GiniVersionInfo } from "@runtime/types";

// react-query delivers observer notifications through a deferred scheduler by
// default, which makes microtask-based flushing racy and deadlocks under fake
// timers. Deliver synchronously for this file. notifyManager exposes no getter
// for the active scheduler, so restore the library's own exported default —
// the value in effect before this override — rather than re-implementing it.
// (The suite's --isolate run is the structural backstop.)
notifyManager.setScheduler((cb) => cb());
afterAll(() => notifyManager.setScheduler(defaultScheduler));

const STORAGE_KEY = "gini.update.gate";

function versionInfo(sha: string): GiniVersionInfo {
  return {
    packageVersion: "1.0.0",
    runtimeDir: "/tmp/gini-runtime",
    git: { sha, shortSha: sha.slice(0, 7), branch: "main", origin: null, upstreamSha: null, updateAvailable: true },
    installedRuntimePresent: true,
    update: { supported: true }
  };
}

function updateResult(over: Partial<GiniUpdateResult> = {}): GiniUpdateResult {
  return {
    beforeSha: "sha-old",
    afterSha: "sha-new",
    commitCount: "1",
    upToDate: false,
    runtimeDir: "/tmp/gini-runtime",
    version: versionInfo("sha-new"),
    restart: { requested: true },
    ...over
  };
}

// Per-test mutable backend state the fetch stub serves from. Tests flip these
// between polls to walk the gate through the update lifecycle. statusPid is
// the gateway process; webPid is the web (Next.js) process answering the
// local __healthz route — the two restart independently.
let statusSha: string;
let statusPid: number | null;
let statusFailing: boolean;
let webPid: number | null;
let healthzFailing: boolean;
let updateResponse: () => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const realFetch = globalThis.fetch;
let reloadSpy: ReturnType<typeof mock>;
let originalReload: typeof window.location.reload;

beforeEach(() => {
  statusSha = "sha-old";
  statusPid = 111;
  statusFailing = false;
  webPid = 444;
  healthzFailing = false;
  updateResponse = async () => jsonResponse(updateResult());

  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/__healthz")) {
      if (healthzFailing) throw new TypeError("connection refused");
      return jsonResponse({ ok: true, service: "gini-web", pid: webPid ?? undefined });
    }
    if (url.includes("/update/check")) return jsonResponse(versionInfo(statusSha));
    if (url.includes("/update")) return updateResponse();
    if (url.includes("/status")) {
      if (statusFailing) throw new TypeError("connection refused");
      return jsonResponse({ ok: true, pid: statusPid ?? undefined, version: versionInfo(statusSha) });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  window.sessionStorage.clear();
  originalReload = window.location.reload;
  reloadSpy = mock(() => {});
  Object.defineProperty(window.location, "reload", { configurable: true, value: reloadSpy });
});

afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
  globalThis.fetch = realFetch;
  window.sessionStorage.clear();
  Object.defineProperty(window.location, "reload", { configurable: true, value: originalReload });
});

// Minimal consumer so tests can read the phase and trigger start() the same
// way the sidebar's update row does.
function Probe() {
  const gate = useUpdateGate();
  return (
    <div>
      <span data-testid="phase">{gate.phase}</span>
      <button onClick={gate.start}>start-update</button>
    </div>
  );
}

function renderGate() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = rtlRender(
    <QueryClientProvider client={client}>
      <UpdateGateProvider>
        <Probe />
      </UpdateGateProvider>
    </QueryClientProvider>
  );
  return { client, view };
}

const phase = () => screen.getByTestId("phase").textContent;

// Flush pending microtasks so awaited fetch promises resolve inside act().
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Force one poll tick on a query (the component's own interval is irrelevant
// to the assertions — what matters is what each response does to the phase).
async function pollStatus(client: QueryClient) {
  await act(async () => {
    await client.refetchQueries({ queryKey: ["status"] }).catch(() => {});
  });
}

async function pollHealthz(client: QueryClient) {
  await act(async () => {
    await client.refetchQueries({ queryKey: ["web", "healthz"] }).catch(() => {});
  });
}

describe("UpdateGate", () => {
  test("holds through the new sha, failed polls, and a new gateway pid served via the old web server; reloads only after both pids change", async () => {
    jest.useFakeTimers();
    const { client } = renderGate();
    await flush();
    expect(phase()).toBe("idle");

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    // The gate blurs immediately, before the slow POST settles. The one-shot
    // __healthz probe records the starting web pid in the same window.
    expect(phase()).toBe("updating");
    expect(screen.getByRole("alertdialog", { name: "Updating Gini" })).not.toBeNull();
    await flush();

    // The OLD gateway reports the new sha (version info comes from git on
    // disk) with its OLD pid — proof of nothing but the checkout. Hold.
    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");
    expect(screen.getByRole("alertdialog", { name: "Restarting Gini" })).not.toBeNull();
    expect(reloadSpy).not.toHaveBeenCalled();

    // Both servers down: polls reject. The gate stays up.
    statusFailing = true;
    healthzFailing = true;
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("restarting");
    expect(reloadSpy).not.toHaveBeenCalled();

    // The gateway respawns first: a status poll traverses the STILL-ALIVE OLD
    // web server to the NEW gateway. The gateway leg is satisfied, but the
    // web pid is unchanged — reloading now would land on the dying web
    // server. Hold.
    statusFailing = false;
    healthzFailing = false;
    statusPid = 222;
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("restarting");
    expect(reloadSpy).not.toHaveBeenCalled();

    // The web server is kickstarted: __healthz answers with a new pid → both
    // processes proven → complete → reload after the confirmation delay.
    webPid = 555;
    await pollHealthz(client);
    expect(phase()).toBe("complete");
    expect(screen.getByRole("alertdialog", { name: "Update complete" })).not.toBeNull();
    expect(reloadSpy).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    // The persisted gate is cleared first so the reloaded page comes up clean.
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("completes on the sha flip without waiting for pid changes when no restart was scheduled", async () => {
    updateResponse = async () => jsonResponse(updateResult({ restart: { requested: false } }));
    const { client } = renderGate();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = "sha-new";
    await pollStatus(client);
    // Servers never go down, so the old pids are fine to reload onto.
    expect(phase()).toBe("complete");
  });

  test("upToDate releases the gate without reloading", async () => {
    updateResponse = async () => jsonResponse(updateResult({ upToDate: true }));
    renderGate();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    expect(phase()).toBe("updating");
    await flush();
    expect(phase()).toBe("idle");
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a failed starting-pid capture degrades the web leg to the freshness fallback", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    // The one-shot __healthz probe at start() fails, so no starting web pid
    // is known; the web leg must still demand a healthz answer that landed
    // after the restart wait began.
    healthzFailing = true;
    const { client } = renderGate();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    statusPid = 222;
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    healthzFailing = false;
    setSystemTime(new Date(t0.getTime() + 5_000));
    await pollHealthz(client);
    expect(phase()).toBe("complete");
  });

  test("a resumed restarting gate waits for a gateway pid change even while polls succeed", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "restarting", beforePid: 111 }));
    const { client } = renderGate();
    await flush();
    expect(phase()).toBe("restarting");

    // Later successful polls still carrying the old gateway pid are the dying
    // old stack — the known starting pid must win over the time-based
    // fallback. (The web leg, whose starting pid was never persisted, is
    // satisfied by the fresh healthz answer; the gateway leg alone holds.)
    setSystemTime(new Date(t0.getTime() + 5_000));
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("restarting");

    statusPid = 222;
    await pollStatus(client);
    expect(phase()).toBe("complete");
  });

  test("a resumed gate without starting pids completes once both queries answer after entering restarting", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    statusPid = null;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "restarting" }));
    const { client } = renderGate();
    await flush();
    // The mount-time responses landed at the same instant the phase was
    // entered — not yet proof of anything newer.
    expect(phase()).toBe("restarting");

    setSystemTime(new Date(t0.getTime() + 5_000));
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("complete");
  });

  test("a verified persisted complete gate resumes and reloads after the delay", async () => {
    jest.useFakeTimers();
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "complete", verified: true }));
    renderGate();
    await flush();
    expect(phase()).toBe("complete");

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a persisted complete without the verified marker re-proves reachability before reloading", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    // Written before "complete" implied a reachability proof — resume into
    // restarting rather than reloading blind onto a possibly-dead stack.
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "complete" }));
    const { client } = renderGate();
    await flush();
    expect(phase()).toBe("restarting");
    expect(reloadSpy).not.toHaveBeenCalled();

    setSystemTime(new Date(t0.getTime() + 5_000));
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("complete");
  });

  test("wrong-typed persisted fields are dropped so the pid legs degrade to the fallback", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    // If the string pids survived, 111 !== "111" would complete the gate off
    // the old stack's very first answer. Dropped fields mean both legs wait
    // for a fresh post-entry poll instead.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ phase: "restarting", beforePid: "111", beforeWebPid: "444", targetSha: 7, restartExpected: "yes" })
    );
    const { client } = renderGate();
    await flush();
    expect(phase()).toBe("restarting");

    setSystemTime(new Date(t0.getTime() + 5_000));
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("complete");
  });

  test("invalid persisted gates are ignored", async () => {
    window.sessionStorage.setItem(STORAGE_KEY, "not json");
    const first = renderGate();
    await flush();
    expect(phase()).toBe("idle");
    first.view.unmount();

    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "bogus" }));
    renderGate();
    await flush();
    expect(phase()).toBe("idle");
  });

  test("a structured gateway error releases the gate; a transport failure keeps it up", async () => {
    updateResponse = async () => jsonResponse({ error: "update failed" }, 500);
    renderGate();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    // The gateway replied non-2xx — a genuine pre-flight failure.
    expect(phase()).toBe("idle");

    // A rejected fetch means the gateway likely restarted before the response
    // flushed: keep the blur and let the detectors / stall timer resolve it.
    updateResponse = async () => {
      throw new TypeError("socket closed");
    };
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    expect(phase()).toBe("updating");
  });

  test("the stall timer releases a gate that never completes", async () => {
    jest.useFakeTimers();
    // A POST that never settles, with status forever on the old sha.
    updateResponse = () => new Promise<Response>(() => {});
    renderGate();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    expect(phase()).toBe("updating");

    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });
    await flush();
    expect(phase()).toBe("idle");
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test("useUpdateGate outside the provider fails loudly", () => {
    expect(() => rtlRender(<Probe />)).toThrow("useUpdateGate must be used within <UpdateGateProvider>");
  });
});

// The sha-only completion fallback (a reload interrupted the POST, so no
// targetSha or restartExpected was persisted) must still hold for the restart:
// restartExpected defaults to true on resume.
describe("UpdateGate resume without a recorded target", () => {
  test("a resumed updating gate moves to restarting on HEAD moving, then completes once both legs answer", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ phase: "updating", beforeSha: "sha-old", beforePid: 111 })
    );
    const { client } = renderGate();
    await flush();
    expect(phase()).toBe("updating");

    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    // The gateway pid flips, but no healthz answer has landed since entering
    // the phase (the starting web pid was never persisted, so the web leg is
    // on its freshness fallback). Hold.
    statusPid = 222;
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    setSystemTime(new Date(t0.getTime() + 5_000));
    await pollHealthz(client);
    expect(phase()).toBe("complete");
  });
});
