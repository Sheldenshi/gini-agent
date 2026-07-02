/// <reference lib="dom" />

// UpdateGate phase machine. The hazard pinned here: POST /update applies the
// new revision on disk in the OLD gateway process, so /status reports the new
// sha while both servers are about to restart — and because the gateway and
// web server bounce independently, a status poll can reach the NEW gateway
// through the still-alive OLD web server. Reloading on the sha or the gateway
// pid alone lands the browser on a dead web server. The gate must hold in
// "restarting" until BOTH servers prove they restarted: a new gateway pid
// from /status AND a new web tree ppid from the local __healthz route — or,
// for a leg whose starting identity is unknown, the first poll on that query
// that succeeds after entering the phase. The web leg keys on ppid (the next
// CLI supervising the worker), not the worker pid: the CLI respawns its
// worker (new pid, same still-old tree) on a next.config.* change, so a
// worker pid flip is no restart proof. Finally, the identity proofs are
// point-in-time, so the gate re-probes __healthz once right before reloading
// and drops back to "restarting" if the web server stopped answering.
//
// LEAK SAFETY: no module mocks — global fetch, window.location.reload,
// toast.error (replaced on the imported sonner object, not the module) and
// sessionStorage are stubbed/cleared per test and restored in afterEach.

import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, setSystemTime, test } from "bun:test";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { defaultScheduler, notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UpdateGateProvider, useUpdateGate } from "./UpdateGate";
import { GATEWAY_RESTARTING_MESSAGE, GATEWAY_UNREACHABLE_CODE } from "@/lib/gateway-codes";
import type { GiniUpdateResult, GiniVersionInfo } from "@runtime/types";
import { toast } from "sonner";

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
// the gateway process. webPid is the Next.js worker answering the local
// __healthz route and webPpid its supervising next CLI — the tree identity
// the gate keys on. A kickstart replaces both; a config-triggered worker
// respawn replaces only webPid. The gateway and web tree restart
// independently.
let statusSha: string;
let statusPid: number | null;
let statusFailing: boolean;
let webPid: number | null;
let webPpid: number | null;
// The served-build identity __healthz reports under production serving. null
// models dev serving (the sha-less dist dir), where the gate keys on ppid.
let webBuildSha: string | null;
let healthzFailing: boolean;
// The gateway's GET /api/version progress flag: true while its single-flight
// update guard is held. Drives the stall-deadline extension.
let updateInProgressFlag: boolean;
// The updateAvailable bit GET /api/version reports. The deadline's final
// verify reads it to infer "HEAD is on the target" when no explicit targetSha
// was recorded.
let updateAvailableFlag: boolean;
let versionFailing: boolean;
let updateResponse: () => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const realFetch = globalThis.fetch;
let reloadSpy: ReturnType<typeof mock>;
let originalReload: typeof window.location.reload;
// Spy on the imported toast.error (a writable own property on the sonner
// object) so the deadline tests can assert the stall notice fired — or didn't,
// on the verify-then-reload path — without rendering real toasts.
let toastErrorSpy: ReturnType<typeof mock>;
const originalToastError = toast.error;

beforeEach(() => {
  statusSha = "sha-old";
  statusPid = 111;
  statusFailing = false;
  webPid = 333;
  webPpid = 444;
  webBuildSha = null;
  healthzFailing = false;
  updateInProgressFlag = false;
  updateAvailableFlag = true;
  versionFailing = false;
  updateResponse = async () => jsonResponse(updateResult());

  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/__healthz")) {
      if (healthzFailing) throw new TypeError("connection refused");
      return jsonResponse({
        ok: true,
        service: "gini-web",
        pid: webPid ?? undefined,
        ppid: webPpid ?? undefined,
        buildSha: webBuildSha ?? undefined
      });
    }
    if (url.includes("/version")) {
      if (versionFailing) throw new TypeError("connection refused");
      const info = versionInfo(statusSha);
      return jsonResponse({
        ...info,
        git: { ...info.git, updateAvailable: updateAvailableFlag },
        updateInProgress: updateInProgressFlag
      });
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
  toastErrorSpy = mock(() => "");
  toast.error = toastErrorSpy as unknown as typeof toast.error;
});

afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
  globalThis.fetch = realFetch;
  window.sessionStorage.clear();
  Object.defineProperty(window.location, "reload", { configurable: true, value: originalReload });
  toast.error = originalToastError;
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

// In-memory stand-in for the cross-tab BroadcastChannel: records what the
// provider posts and lets tests deliver messages as if a sibling tab sent
// them (a real channel never echoes to its own sender, so posted messages
// are NOT looped back).
interface FakeGateChannel {
  posted: unknown[];
  postMessage: (message: unknown) => void;
  close: () => void;
  onmessage: ((event: MessageEvent) => void) | null;
  emit: (data: unknown) => void;
}

function makeFakeChannel(): FakeGateChannel {
  const channel: FakeGateChannel = {
    posted: [],
    postMessage(message) {
      channel.posted.push(message);
    },
    close() {},
    onmessage: null,
    emit(data) {
      channel.onmessage?.({ data } as MessageEvent);
    }
  };
  return channel;
}

function renderGate(
  props: {
    stallTimeoutMs?: number;
    progressPollIntervalMs?: number;
    progressExtendMs?: number;
    gateHardCapMs?: number;
    createGateChannel?: () => FakeGateChannel | null;
  } = {}
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = rtlRender(
    <QueryClientProvider client={client}>
      <UpdateGateProvider {...props}>
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

async function pollProgress(client: QueryClient) {
  await act(async () => {
    await client.refetchQueries({ queryKey: ["version", "progress"] }).catch(() => {});
  });
}

describe("UpdateGate", () => {
  test("holds through the new sha, failed polls, and a new gateway pid served via the old web server; reloads only after both identities change", async () => {
    jest.useFakeTimers();
    const { client } = renderGate();
    await flush();
    expect(phase()).toBe("idle");

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    // The gate blurs immediately, before the slow POST settles. The one-shot
    // __healthz probe records the starting web tree (ppid) in the same window.
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
    // web tree (ppid) is unchanged — reloading now would land on the dying
    // web server. Hold.
    statusFailing = false;
    healthzFailing = false;
    statusPid = 222;
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("restarting");
    expect(reloadSpy).not.toHaveBeenCalled();

    // The web server is kickstarted: the whole tree is replaced, so __healthz
    // answers with a new ppid → both servers proven → complete → after the
    // confirmation delay the pre-reload probe succeeds → reload.
    webPid = 999;
    webPpid = 555;
    await pollHealthz(client);
    expect(phase()).toBe("complete");
    expect(screen.getByRole("alertdialog", { name: "Update complete" })).not.toBeNull();
    expect(reloadSpy).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flush();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    // The persisted gate is cleared first so the reloaded page comes up clean.
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("production serving completes the web leg on a matching buildSha even when the ppid never changes", async () => {
    jest.useFakeTimers();
    // The user's race: the supervising ppid transition is missed/never
    // observed, so the legacy proxy leg can't latch. Under production serving
    // __healthz also reports buildSha — the sha of the code it serves — so the
    // restarted server proves itself directly. afterSha is the full revision;
    // buildSha is the --short form, so the gate prefix-matches.
    const targetSha = "0123456789abcdef0123456789abcdef01234567";
    updateResponse = async () => jsonResponse(updateResult({ afterSha: targetSha, version: versionInfo(targetSha) }));
    const { client } = renderGate();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();

    statusSha = targetSha;
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    // The gateway restarts (pid flips). The web server restarts too, but its
    // ppid is UNCHANGED — only the served build moved to the target's short
    // sha. The legacy leg would hold forever here; the buildSha leg releases.
    statusPid = 222;
    webBuildSha = targetSha.slice(0, 12);
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("complete");

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flush();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  test("dev serving without a buildSha still completes the web leg via the ppid fallback", async () => {
    const { client } = renderGate();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    // No buildSha (dev dist dir) and the ppid is unchanged: neither web signal
    // is satisfied, so the gate holds exactly as before this signal existed.
    statusPid = 222;
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("restarting");
    expect(reloadSpy).not.toHaveBeenCalled();

    // The ppid flips → the legacy web leg latches → complete.
    webPpid = 555;
    await pollHealthz(client);
    expect(phase()).toBe("complete");
  });

  test("a malformed (too-short) buildSha does not complete the web leg; it falls back to ppid", async () => {
    // buildSha is contractually >=12 hex; a degenerate short value (here a
    // truncated prefix of the target) must NOT prefix-match the target and
    // release the gate. The web leg falls back to the ppid signal.
    const targetSha = "0123456789abcdef0123456789abcdef01234567";
    updateResponse = async () => jsonResponse(updateResult({ afterSha: targetSha, version: versionInfo(targetSha) }));
    const { client } = renderGate();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = targetSha;
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    // Gateway restarts (pid flips) and __healthz answers, but with a 4-char
    // buildSha and an unchanged ppid: neither web signal is satisfied, so hold.
    statusPid = 222;
    webBuildSha = targetSha.slice(0, 4);
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("restarting");
    expect(reloadSpy).not.toHaveBeenCalled();

    // A full >=12 buildSha now matches → the web leg latches → complete.
    webBuildSha = targetSha.slice(0, 12);
    await pollHealthz(client);
    expect(phase()).toBe("complete");
  });

  test("a worker respawn — new worker pid, same tree ppid — does not satisfy the web leg", async () => {
    const { client } = renderGate();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    // The gateway restarts; the web tree has not. An update whose checkout
    // touches next.config.* makes the next CLI respawn its worker — a NEW
    // worker pid served by the STILL-OLD tree. If the web leg keyed on the
    // worker pid this would release the reload onto a server the kickstart is
    // about to replace. The supervising ppid is unchanged, so hold.
    statusPid = 222;
    webPid = 999;
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("restarting");
    expect(reloadSpy).not.toHaveBeenCalled();

    // The kickstart lands: the whole tree — and so the ppid — is replaced.
    webPpid = 555;
    await pollHealthz(client);
    expect(phase()).toBe("complete");
  });

  test("a web tree restart alone does not release the gate while the gateway pid is unchanged", async () => {
    const { client } = renderGate();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    // The mirror interleaving: the web kickstart lands first while /status
    // still answers from the OLD gateway. The web leg is satisfied; the
    // gateway leg holds the gate.
    webPid = 999;
    webPpid = 555;
    await pollHealthz(client);
    await pollStatus(client);
    expect(phase()).toBe("restarting");
    expect(reloadSpy).not.toHaveBeenCalled();

    statusPid = 222;
    await pollStatus(client);
    expect(phase()).toBe("complete");
  });

  test("a failed pre-reload probe never reloads; the reload fires on the first probe that succeeds", async () => {
    jest.useFakeTimers();
    const { client } = renderGate();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = "sha-new";
    await pollStatus(client);
    statusPid = 222;
    webPid = 999;
    webPpid = 555;
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("complete");

    // The web server stops answering between the identity proof and the
    // reload — the proofs are point-in-time. The pre-reload probe fails → no
    // reload; the gate drops back to restarting. Both identity legs latch on
    // retained query data, so it re-completes and re-arms the probe, cycling
    // without ever reloading while the server is down.
    healthzFailing = true;
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flush();
    expect(reloadSpy).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flush();
    expect(reloadSpy).not.toHaveBeenCalled();

    // The server answers again → the next probe succeeds → reload.
    healthzFailing = false;
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flush();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("completes on the sha flip without waiting for identity changes when no restart was scheduled", async () => {
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

  test("a failed starting-identity capture degrades the web leg to the freshness fallback", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    // The one-shot __healthz probe at start() fails, so no starting web tree
    // ppid is known; the web leg must still demand a healthz answer that
    // landed after the restart wait began.
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
    // fallback. (The web leg, whose starting ppid was never persisted, is
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

  test("a fresh updateInProgress:true holds the time-fallback legs until a false answer", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    statusPid = null;
    // Both baselines unknown — the follower shape: it never has a pending
    // POST, so it can sit in "restarting" minutes before the real restart.
    // While the gateway's progress answers say the update is still running,
    // post-entry poll successes are answers from the still-OLD stack and
    // must not latch the fallback legs.
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "restarting" }));
    updateInProgressFlag = true;
    const { client } = renderGate();
    await flush();
    expect(phase()).toBe("restarting");
    await pollProgress(client);

    setSystemTime(new Date(t0.getTime() + 5_000));
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("restarting");
    expect(reloadSpy).not.toHaveBeenCalled();

    // The single-flight guard released → the update is over; the plain
    // fallback resumes and the already-landed post-entry answers complete
    // the gate.
    updateInProgressFlag = false;
    setSystemTime(new Date(t0.getTime() + 10_000));
    await pollProgress(client);
    expect(phase()).toBe("complete");
  });

  test("a progress poll failure after the last true answer resumes the time fallback", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    statusPid = null;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "restarting" }));
    updateInProgressFlag = true;
    const { client } = renderGate();
    await flush();
    expect(phase()).toBe("restarting");
    await pollProgress(client);

    setSystemTime(new Date(t0.getTime() + 5_000));
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("restarting");

    // The gateway goes quiet mid-restart: the failure is NEWER than the
    // retained true answer, so the hold drops and the fallback behaves
    // exactly as before the progress poll existed.
    versionFailing = true;
    setSystemTime(new Date(t0.getTime() + 10_000));
    await pollProgress(client);
    expect(phase()).toBe("complete");
  });

  test("a verified persisted complete gate resumes, passes the pre-reload probe, and reloads", async () => {
    jest.useFakeTimers();
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "complete", verified: true }));
    renderGate();
    await flush();
    expect(phase()).toBe("complete");

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flush();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a resumed verified complete drops back to restarting when the pre-reload probe fails, then re-proves and reloads", async () => {
    jest.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    // The verified marker proved reachability BEFORE the reload that resumed
    // this gate — the web server can have gone down since. The probe is the
    // recheck.
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "complete", verified: true }));
    healthzFailing = true;
    const { client } = renderGate();
    await flush();
    expect(phase()).toBe("complete");

    await act(async () => {
      jest.advanceTimersByTime(1_500);
      // advanceTimersByTime unpins the mocked clock back to real time; re-pin
      // it before the probe's rejection settles so restartingSince — stamped
      // in the drop-back below — is deterministic.
      setSystemTime(new Date(t0.getTime() + 2_000));
    });
    await flush();
    // No reload; back to waiting on the restart. A verified complete carries
    // no starting identities, so both legs sit on the freshness fallback and
    // the phase visibly holds until fresh polls land.
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(phase()).toBe("restarting");

    healthzFailing = false;
    setSystemTime(new Date(t0.getTime() + 30_000));
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("complete");

    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flush();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
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

  test("wrong-typed persisted fields are dropped so the identity legs degrade to the fallback", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    // If the string identities survived, 111 !== "111" would complete the
    // gate off the old stack's very first answer. Dropped fields mean both
    // legs wait for a fresh post-entry poll instead.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        phase: "restarting",
        beforePid: "111",
        beforeWebPpid: "444",
        targetSha: 7,
        restartExpected: "yes",
        startedAt: "earlier"
      })
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

  test("the BFF's gateway_unreachable 503 keeps the gate up (gateway died mid-POST, not a pre-flight failure)", async () => {
    // The wire shape the BFF answers with when the gateway drops the in-flight
    // POST: a structured 503 envelope. It carries an HTTP status like a real
    // gateway error, so a status-only release check would tear the gate down
    // in exactly the restart window it exists to cover — the unreachable tag
    // from the shared envelope contract must keep the blur.
    updateResponse = async () =>
      jsonResponse({ error: GATEWAY_RESTARTING_MESSAGE, code: GATEWAY_UNREACHABLE_CODE }, 503);
    renderGate();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    expect(phase()).toBe("updating");
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  test("the stall timer releases a gate that never completes", async () => {
    jest.useFakeTimers();
    // A POST that never settles, with status forever on the old sha. The
    // deadline is injected short so the release lands inside one sub-poll tick.
    // Advancing the 240s production default in one synchronous step instead
    // would fire each 1.5s poll interval 160 times (240000 / 1500) across the
    // status and healthz queries — 320 refetch cycles — which wedges the worker
    // under `bun test --isolate`.
    updateResponse = () => new Promise<Response>(() => {});
    renderGate({ stallTimeoutMs: 1_000 });
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    expect(phase()).toBe("updating");

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    await flush();
    expect(phase()).toBe("idle");
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test("the deadline reloads without erroring when the final verify finds the stack up on target (dev fallback)", async () => {
    jest.useFakeTimers();
    // The detectors miss the restart entirely (dev serving: no buildSha, and
    // the ppid never observed flipping), so the gate sits in "restarting" past
    // the deadline. But the stack DID land: /version reports the target sha
    // and __healthz answers. The deadline must verify-then-reload, not toast.
    const { client } = renderGate({ stallTimeoutMs: 5_000 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await flush();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(toastErrorSpy).not.toHaveBeenCalled();
    // Cleared first so the reloaded page comes up clean (like a normal complete).
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("the deadline verify accepts the web leg via a matching buildSha", async () => {
    jest.useFakeTimers();
    const targetSha = "0123456789abcdef0123456789abcdef01234567";
    updateResponse = async () => jsonResponse(updateResult({ afterSha: targetSha, version: versionInfo(targetSha) }));
    const { client } = renderGate({ stallTimeoutMs: 5_000 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = targetSha;
    // Under production serving the verify additionally requires the served
    // build to match the target; here it does.
    webBuildSha = targetSha.slice(0, 12);
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await flush();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  test("the deadline verify treats a malformed buildSha as absent and passes the web leg on reachability", async () => {
    jest.useFakeTimers();
    // A too-short buildSha can't stand in for the target, so the web leg falls
    // back to reachability (as in dev) rather than letting a degenerate prefix
    // match. HEAD is on target and __healthz answers, so the verify reloads.
    const targetSha = "0123456789abcdef0123456789abcdef01234567";
    updateResponse = async () => jsonResponse(updateResult({ afterSha: targetSha, version: versionInfo(targetSha) }));
    const { client } = renderGate({ stallTimeoutMs: 5_000 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = targetSha;
    webBuildSha = targetSha.slice(0, 4);
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await flush();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  test("the deadline verify infers completion from updateAvailable:false when no target was recorded", async () => {
    jest.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    // A resumed gate whose POST was interrupted: no targetSha. The verify
    // can't match an explicit sha, so it infers "HEAD is on target" from the
    // gateway reporting nothing left to pull.
    statusSha = "sha-new";
    updateAvailableFlag = false;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ phase: "restarting", startedAt: t0.getTime() }));
    renderGate({ stallTimeoutMs: 5_000 });
    await flush();
    expect(phase()).toBe("restarting");

    await act(async () => {
      jest.advanceTimersByTime(5_000);
      setSystemTime(new Date(t0.getTime() + 5_000));
    });
    await flush();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  test("the deadline still errors when the verify finds the stack not up on target", async () => {
    jest.useFakeTimers();
    // HEAD reached the target, but the web server is down (the failed-restart
    // shape): the verify's __healthz read rejects, so the stack is NOT up and
    // the original stall notice fires.
    const { client } = renderGate({ stallTimeoutMs: 5_000 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    healthzFailing = true;
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await flush();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(toastErrorSpy).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("idle");
  });

  test("the deadline still errors when the gateway reports an update still in flight", async () => {
    jest.useFakeTimers();
    // HEAD and the web build are on target, but the gateway's single-flight
    // guard is still held: the update is not actually finished, so the verify
    // rejects the reload and the notice fires.
    const { client } = renderGate({ stallTimeoutMs: 5_000 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    updateInProgressFlag = true;
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await flush();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(toastErrorSpy).toHaveBeenCalledTimes(1);
    expect(phase()).toBe("idle");
  });

  test("an updateInProgress:true progress answer extends the stall deadline; silence after it releases at the extension", async () => {
    jest.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    // A POST that never settles, status forever on the old sha — only the
    // progress poll vouches for the update. The poll interval is injected
    // far out so polls happen only when the test drives them: extension must
    // come from an actual gateway answer, not the passage of time.
    updateResponse = () => new Promise<Response>(() => {});
    updateInProgressFlag = true;
    const { client } = renderGate({ stallTimeoutMs: 2_000, progressExtendMs: 5_000, progressPollIntervalMs: 600_000 });
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    expect(phase()).toBe("updating");
    await flush();
    // The gateway answers "still working" → deadline pushed to t0 + 5s.
    await pollProgress(client);

    // Past the 2s base deadline: the extension holds the blur.
    await act(async () => {
      jest.advanceTimersByTime(2_500);
      setSystemTime(new Date(t0.getTime() + 2_500));
    });
    await flush();
    expect(phase()).toBe("updating");

    // No further progress answers: the extended deadline is final and the
    // gate releases there.
    await act(async () => {
      jest.advanceTimersByTime(3_000);
      setSystemTime(new Date(t0.getTime() + 5_500));
    });
    await flush();
    expect(phase()).toBe("idle");
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test("updateInProgress:false extends nothing — the base deadline releases the gate", async () => {
    jest.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    updateResponse = () => new Promise<Response>(() => {});
    updateInProgressFlag = false;
    const { client } = renderGate({ stallTimeoutMs: 1_000, progressExtendMs: 5_000, progressPollIntervalMs: 600_000 });
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    await pollProgress(client);

    await act(async () => {
      jest.advanceTimersByTime(1_000);
      setSystemTime(new Date(t0.getTime() + 1_000));
    });
    await flush();
    expect(phase()).toBe("idle");
  });

  test("a failing progress poll extends nothing — the base deadline releases the gate", async () => {
    jest.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    updateResponse = () => new Promise<Response>(() => {});
    versionFailing = true;
    const { client } = renderGate({ stallTimeoutMs: 1_000, progressExtendMs: 5_000, progressPollIntervalMs: 600_000 });
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    await pollProgress(client);

    await act(async () => {
      jest.advanceTimersByTime(1_000);
      setSystemTime(new Date(t0.getTime() + 1_000));
    });
    await flush();
    expect(phase()).toBe("idle");
  });

  test("progress extensions never push the deadline past the hard cap", async () => {
    jest.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    updateResponse = () => new Promise<Response>(() => {});
    updateInProgressFlag = true;
    // Each answer asks for now + 10s, but the cap (3s from gate start) wins:
    // a wedged-but-alive gateway saying "still working" forever must not
    // blur the app forever.
    const { client } = renderGate({
      stallTimeoutMs: 1_000,
      progressExtendMs: 10_000,
      gateHardCapMs: 3_000,
      progressPollIntervalMs: 600_000
    });
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    await pollProgress(client);

    // Past the 1s base deadline: the (capped) extension holds.
    await act(async () => {
      jest.advanceTimersByTime(1_500);
      setSystemTime(new Date(t0.getTime() + 1_500));
    });
    await flush();
    expect(phase()).toBe("updating");
    // A fresh "still working" answer cannot move the deadline past the cap.
    await pollProgress(client);

    await act(async () => {
      jest.advanceTimersByTime(2_000);
      setSystemTime(new Date(t0.getTime() + 3_500));
    });
    await flush();
    expect(phase()).toBe("idle");
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test("a resumed gate anchors the hard cap at the persisted gate start, not the reload", async () => {
    jest.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    // The gate engaged 1s before the reload that resumed it. With the cap
    // re-armed from the resume instead, a wedged-but-alive update could hold
    // the blur indefinitely — 30 fresh minutes per reload — so the deadline
    // (start + 2s) and the cap (start + 3s) must both anchor at the
    // PERSISTED start: t0 + 1s and t0 + 2s here.
    updateInProgressFlag = true;
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ phase: "updating", startedAt: t0.getTime() - 1_000 })
    );
    const { client } = renderGate({
      stallTimeoutMs: 2_000,
      gateHardCapMs: 3_000,
      progressExtendMs: 10_000,
      progressPollIntervalMs: 600_000
    });
    await flush();
    expect(phase()).toBe("updating");
    // "Still working" extends the deadline — but only to the resumed cap.
    await pollProgress(client);

    await act(async () => {
      jest.advanceTimersByTime(1_500);
      setSystemTime(new Date(t0.getTime() + 1_500));
    });
    await flush();
    expect(phase()).toBe("updating");
    // A fresh answer still cannot move the deadline past the original cap.
    await pollProgress(client);

    // t0 + 2.5s is past the resumed cap (start + 3s = t0 + 2s); a cap
    // re-armed at the resume (t0 + 3s) would still be holding here.
    await act(async () => {
      jest.advanceTimersByTime(1_000);
      setSystemTime(new Date(t0.getTime() + 2_500));
    });
    await flush();
    expect(phase()).toBe("idle");
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  test("the complete↔restarting probe-failure cycle cannot outlive the stall deadline", async () => {
    jest.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    setSystemTime(t0);
    const { client } = renderGate({ stallTimeoutMs: 5_000 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    await flush();
    statusSha = "sha-new";
    await pollStatus(client);
    statusPid = 222;
    webPid = 999;
    webPpid = 555;
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("complete");

    // The web server proves its restart, then dies for good. Every pre-reload
    // probe fails → drop back to restarting → the latched identity legs
    // re-complete the gate instantly → a fresh probe is armed. Each lap
    // crosses two phase transitions, so a stall timer re-armed per phase
    // would be cleared every 1.5s and never fire. The deadline is fixed when
    // the gate leaves idle, so once it passes the gate must release — no
    // reload, back to idle, persisted gate cleared. The deadline is injected
    // short so this runs in a few laps: at the 240s default it would take 160
    // laps, and each lap's 1.5s advance fires the poll intervals, which wedges
    // the worker under `bun test --isolate`.
    healthzFailing = true;
    let now = t0.getTime();
    // 4 laps of 1.5s reach 6s, past the 5s injected deadline.
    for (let i = 0; i < 6 && phase() !== "idle"; i++) {
      await act(async () => {
        jest.advanceTimersByTime(1_500);
        // advanceTimersByTime unpins the mocked clock back to real time;
        // re-pin it in lockstep so the deadline's remaining wall-clock time
        // shrinks with the fake-timer laps.
        now += 1_500;
        setSystemTime(new Date(now));
      });
      await flush();
    }
    expect(phase()).toBe("idle");
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
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
    // the phase (the starting web ppid was never persisted, so the web leg is
    // on its freshness fallback). Hold.
    statusPid = 222;
    await pollStatus(client);
    expect(phase()).toBe("restarting");

    setSystemTime(new Date(t0.getTime() + 5_000));
    await pollHealthz(client);
    expect(phase()).toBe("complete");
  });
});

// The cross-tab gate: an update started in one tab must blur every open tab
// — an unblurred sibling keeps hitting the stack mid-restart and can
// hard-navigate onto a dead port. The owner broadcasts {type:"start"} /
// {type:"done"} on BroadcastChannel("gini-update-gate"); a follower engages
// the same gate without owning the POST and exits through its own
// detection, or through the owner's "done" when the update ended without a
// restart.
describe("UpdateGate cross-tab", () => {
  test("the owner broadcasts start on engage and done on a restart-free release", async () => {
    updateResponse = async () => jsonResponse(updateResult({ upToDate: true }));
    const channel = makeFakeChannel();
    renderGate({ createGateChannel: () => channel });
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    // The start goes out the moment the gate engages, before the POST
    // settles — followers must blur for the whole window.
    expect(channel.posted).toEqual([{ type: "start" }]);
    await flush();
    // upToDate released this gate; followers are told to release too.
    expect(phase()).toBe("idle");
    expect(channel.posted).toEqual([{ type: "start" }, { type: "done" }]);
  });

  test("a start broadcast engages a follower that never POSTs, persists like an owner, and reloads via its own detection", async () => {
    jest.useFakeTimers();
    let updatePosts = 0;
    updateResponse = async () => {
      updatePosts += 1;
      return jsonResponse(updateResult());
    };
    const channel = makeFakeChannel();
    const { client } = renderGate({ createGateChannel: () => channel });
    await flush();
    expect(phase()).toBe("idle");

    act(() => channel.emit({ type: "start" }));
    expect(phase()).toBe("updating");
    await flush();
    // The follower owns no POST and re-broadcasts nothing...
    expect(updatePosts).toBe(0);
    expect(channel.posted).toEqual([]);
    // ...but persists the same resumable gate as an owner, so a mid-update
    // reload re-blurs (the resume machinery is pinned by the resume tests).
    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!).phase).toBe("updating");

    // It walks the same completion detection as an owner whose POST was
    // interrupted: HEAD moves off the engage-time sha → restarting; both
    // identity legs flip → complete → probe-then-reload.
    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");
    statusPid = 222;
    webPpid = 555;
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("complete");
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flush();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    // The reload broadcasts nothing — "done" belongs to the owner.
    expect(channel.posted).toEqual([]);
  });

  test("a follower persisted mid-update resumes the blur on the reloaded page without a fresh broadcast", async () => {
    const channel = makeFakeChannel();
    const first = renderGate({ createGateChannel: () => channel });
    await flush();
    act(() => channel.emit({ type: "start" }));
    expect(phase()).toBe("updating");
    first.view.unmount();

    // Same tab, same sessionStorage: the reloaded page re-blurs on mount.
    renderGate({ createGateChannel: () => makeFakeChannel() });
    await flush();
    expect(phase()).toBe("updating");
  });

  test("done releases a follower whose sha never moved; one already restarting finishes on its own", async () => {
    const channel = makeFakeChannel();
    const { client } = renderGate({ createGateChannel: () => channel });
    await flush();
    act(() => channel.emit({ type: "start" }));
    expect(phase()).toBe("updating");
    // The owner's update ended without the sha ever moving here (upToDate or
    // a pre-flight failure): release rather than blur until the deadline.
    act(() => channel.emit({ type: "done" }));
    expect(phase()).toBe("idle");
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();

    // Re-engage and reach "restarting": now "done" must NOT release — a
    // release here would strand the tab on stale assets; its own detection
    // finishes with the reload instead.
    act(() => channel.emit({ type: "start" }));
    await flush();
    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");
    act(() => channel.emit({ type: "done" }));
    expect(phase()).toBe("restarting");
  });

  test("a single-flight 409 demotes the losing owner to a follower instead of unblurring everyone", async () => {
    jest.useFakeTimers();
    // Two tabs clicked inside the broadcast latency; this tab's POST lost
    // the gateway's single-flight guard. The structured 409 must NOT
    // reset-and-broadcast-done — that would release every follower while
    // the winner's update runs. The loser keeps the blur as a follower.
    updateResponse = async () => jsonResponse({ error: "gini update already in progress." }, 409);
    const channel = makeFakeChannel();
    const { client } = renderGate({ createGateChannel: () => channel });
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "start-update" }));
    expect(channel.posted).toEqual([{ type: "start" }]);
    await flush();
    expect(phase()).toBe("updating");
    expect(channel.posted).toEqual([{ type: "start" }]);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();

    // It finishes through follower detection — and the reload broadcasts
    // nothing, because the tab no longer owns the update.
    statusSha = "sha-new";
    await pollStatus(client);
    expect(phase()).toBe("restarting");
    statusPid = 222;
    webPpid = 555;
    await pollStatus(client);
    await pollHealthz(client);
    expect(phase()).toBe("complete");
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    await flush();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(channel.posted).toEqual([{ type: "start" }]);
  });

  test("a platform without BroadcastChannel degrades to a single-tab gate", async () => {
    const scope = globalThis as { BroadcastChannel?: typeof BroadcastChannel };
    const original = scope.BroadcastChannel;
    delete scope.BroadcastChannel;
    try {
      // No injected channel: the default factory finds no BroadcastChannel
      // and the provider runs without one — the gate still blurs locally.
      renderGate();
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "start-update" }));
      expect(phase()).toBe("updating");
      await flush();
    } finally {
      if (original !== undefined) scope.BroadcastChannel = original;
    }
  });
});
