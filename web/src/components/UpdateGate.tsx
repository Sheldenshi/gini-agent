"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, type ApiError } from "@/lib/api";
import { useStatus } from "@/lib/queries";
import type { GiniUpdateResult, GiniVersionInfo } from "@runtime/types";

type UpdatePhase = "idle" | "updating" | "restarting" | "complete";

export interface UpdateGateValue {
  version: GiniVersionInfo | undefined;
  updateSupported: boolean;
  updateAvailable: boolean;
  phase: UpdatePhase;
  start: () => void;
}

const UpdateGateContext = createContext<UpdateGateValue | null>(null);

// Consumed by the sidebar's update control. Throws if rendered outside the
// provider so a missing mount surfaces loudly instead of silently no-op'ing.
export function useUpdateGate(): UpdateGateValue {
  const value = useContext(UpdateGateContext);
  if (!value) throw new Error("useUpdateGate must be used within <UpdateGateProvider>");
  return value;
}

// Applying an update restarts the gateway AND the web server, which can force a
// full page reload mid-update (Next dev fast-refresh on a server restart, or the
// user reloading). Persist the in-flight phase so a reload re-blurs the app and
// resumes watching for the new revision instead of briefly handing control back
// to the user. sessionStorage (not local) scopes the gate to this tab so it
// can't wedge "updating" across an unrelated future session.
const STORAGE_KEY = "gini.update.gate";

interface PersistedGate {
  phase: "updating" | "restarting" | "complete";
  // The revision the runtime should report once the update lands. Set after the
  // POST returns; absent if a reload interrupts the POST.
  targetSha?: string;
  // The revision when the update started. Lets a resumed gate detect completion
  // by "HEAD moved" even without a targetSha.
  beforeSha?: string;
  // The gateway pid when the update started. The restarting phase completes
  // only once a status poll reports a different pid — proof the response came
  // from the restarted gateway, not the old process winding down.
  beforePid?: number;
  // The web-server tree identity when the update started: the __healthz
  // route's `ppid` (the next CLI supervising the worker). The gateway and web
  // server restart independently, so a status poll can reach the NEW gateway
  // through the still-alive OLD web server; the restarting phase additionally
  // requires __healthz to report a different ppid before reloading onto the
  // web port. The worker pid is no proof: the next CLI respawns the worker —
  // new pid, same tree — on any next.config.* change, which an update's
  // checkout can trigger while the OLD tree is still serving.
  beforeWebPpid?: number;
  // Whether the POST scheduled a runtime restart. When false the servers stay
  // up, so the gate may reload as soon as the new revision is reported.
  restartExpected?: boolean;
  // Set only when "complete" was reached through the reachability proof above
  // (or no restart was scheduled, so the servers never went down). A persisted
  // complete WITHOUT this marker resumes into "restarting" and re-proves the
  // stack is up instead of reloading blind.
  verified?: boolean;
  // When the gate first left idle (epoch ms). A resumed gate anchors its base
  // stall deadline and the absolute hard cap to THIS instant, not the reload:
  // re-arming the 30-minute ceiling on every restart-triggered reload would
  // let a wedged-but-alive update hold the blur indefinitely, one reload at a
  // time.
  startedAt?: number;
}

function readPersistedGate(): PersistedGate | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const phase = parsed.phase;
    if (phase !== "updating" && phase !== "restarting" && phase !== "complete") return null;
    // Re-validate every optional field: a corrupted value (say, a string pid)
    // would otherwise compare unequal to every live pid and complete the gate
    // off the dying old stack. Wrong-typed fields drop to undefined, which
    // degrades that leg to its time-based fallback instead.
    return {
      phase,
      targetSha: typeof parsed.targetSha === "string" ? parsed.targetSha : undefined,
      beforeSha: typeof parsed.beforeSha === "string" ? parsed.beforeSha : undefined,
      beforePid: typeof parsed.beforePid === "number" ? parsed.beforePid : undefined,
      beforeWebPpid: typeof parsed.beforeWebPpid === "number" ? parsed.beforeWebPpid : undefined,
      restartExpected: typeof parsed.restartExpected === "boolean" ? parsed.restartExpected : undefined,
      verified: parsed.verified === true ? true : undefined,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : undefined
    };
  } catch {
    return null;
  }
}

function writePersistedGate(value: PersistedGate | null): void {
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private-mode / quota failures leave the gate working in memory for this
    // page's lifetime; it just won't survive a mid-update reload.
  }
}

// Cross-tab gate channel. One update should blur EVERY open tab, not just
// the one that clicked: an unblurred sibling tab keeps hitting the stack
// mid-restart and can hard-navigate onto a dead port. The owner tab
// broadcasts {type:"start"} the moment its gate engages and {type:"done"}
// when its update ends (release or completion); every other provider
// follows — same blur, same completion detection, same deadline rules.
const GATE_CHANNEL_NAME = "gini-update-gate";

// The slice of BroadcastChannel the gate uses, injectable for tests (the
// test DOM may not implement it) and null when the platform lacks it.
export interface GateChannel {
  postMessage: (message: unknown) => void;
  close: () => void;
  onmessage: ((event: MessageEvent) => void) | null;
}

function defaultGateChannel(): GateChannel | null {
  // No BroadcastChannel (an old WebView, a non-browser DOM): the gate
  // degrades to single-tab behavior rather than failing.
  if (typeof BroadcastChannel === "undefined") return null;
  return new BroadcastChannel(GATE_CHANNEL_NAME);
}

// Hold the "complete" confirmation on screen this long before the final
// pre-reload probe and the reload onto the freshly built assets.
const COMPLETE_RELOAD_DELAY_MS = 1_500;
// Whole-gate deadline: a generous ceiling on the entire update (git + bun
// install in both roots, the sha-keyed production `next build` of the web
// app — itself up to ~90s — the restart, and the pre-reload probe). The
// deadline is set the moment the gate leaves idle; phase transitions and
// probe drop-backs reschedule against it with the remaining time. The ONLY
// thing that moves it is the progress poll below — a gateway that answers
// `updateInProgress: true` proves work is still happening, so the deadline
// is pushed out (capped by GATE_HARD_CAP_MS); a hung or dead gateway extends
// nothing and this base deadline releases the blur as before. If the update
// hasn't reloaded by the deadline, the gate releases rather than trapping
// the user behind a permanent blur. The completion detectors normally tear
// the gate down long before this fires.
const STALL_TIMEOUT_MS = 240_000;
// While the gate is waiting, GET /api/version (via the BFF proxy) is polled
// at this cadence for the gateway's `updateInProgress` flag — the
// single-flight update guard, true exactly while updateRuntime is running.
const PROGRESS_POLL_INTERVAL_MS = 5_000;
// Each `updateInProgress: true` answer pushes the stall deadline out to at
// least now + this much. 90s comfortably outlasts the poll cadence and the
// longest single step (the production `next build`) between answers, while
// keeping the post-progress release window short once the gateway goes
// quiet. `false`, errors, and silence extend nothing.
const PROGRESS_EXTEND_MS = 90_000;
// Absolute ceiling on the whole gate, measured from the moment it leaves
// idle. Progress extensions never push the deadline past this — a gateway
// stuck in a wedged-but-alive update (the single-flight promise never
// settles) must not blur the app forever.
const GATE_HARD_CAP_MS = 30 * 60_000;

export function UpdateGateProvider({
  children,
  // The whole-gate deadline is injectable so tests can drive the stall release
  // without advancing fake time across the 240s default — a single advance that
  // long fires the 1.5s status/healthz poll intervals 160 times each (240000 /
  // 1500) and wedges the worker under `bun test --isolate`. The progress-poll
  // timings below are injectable for the same reason. Production always uses
  // the constant defaults.
  stallTimeoutMs = STALL_TIMEOUT_MS,
  progressPollIntervalMs = PROGRESS_POLL_INTERVAL_MS,
  progressExtendMs = PROGRESS_EXTEND_MS,
  gateHardCapMs = GATE_HARD_CAP_MS,
  // The cross-tab channel factory, injectable for tests.
  createGateChannel = defaultGateChannel
}: {
  children: ReactNode;
  stallTimeoutMs?: number;
  progressPollIntervalMs?: number;
  progressExtendMs?: number;
  gateHardCapMs?: number;
  createGateChannel?: () => GateChannel | null;
}) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [targetSha, setTargetSha] = useState<string | null>(null);
  const [beforeSha, setBeforeSha] = useState<string | null>(null);
  const [beforePid, setBeforePid] = useState<number | null>(null);
  const [beforeWebPpid, setBeforeWebPpid] = useState<number | null>(null);
  const [restartExpected, setRestartExpected] = useState(true);
  // When the gate entered "restarting" — see the pid-less fallbacks below.
  const [restartingSince, setRestartingSince] = useState<number | null>(null);
  // Wall-clock deadline for the whole gate, set when it leaves "idle" and
  // cleared when it returns — see the stall safety net below. Pushed out by
  // the progress poll while the gateway reports updateInProgress, capped by
  // hardCapRef.
  const stallDeadlineRef = useRef<number | null>(null);
  // Absolute ceiling for progress extensions, fixed when the gate leaves
  // "idle": no amount of gateway progress holds the blur past this.
  const hardCapRef = useRef<number | null>(null);
  // When the gate first left idle. Persisted with the gate and restored on
  // resume so the deadline and hard cap above stay anchored to the ORIGINAL
  // start across mid-update reloads (see PersistedGate.startedAt).
  const startedAtRef = useRef<number | null>(null);
  // Bumped whenever the progress poll moves the deadline so the stall effect
  // below re-runs and re-arms its timer against the new deadline (a ref
  // change alone re-schedules nothing).
  const [deadlineExtensions, setDeadlineExtensions] = useState(0);
  // The live cross-tab channel (null when unsupported) and whether THIS tab
  // owns the in-flight POST. Only the owner broadcasts; a follower blurs,
  // detects completion, and reloads entirely on its own.
  const channelRef = useRef<GateChannel | null>(null);
  const ownerRef = useRef(false);

  // Poll status fast while updating/restarting so the new revision — and then
  // the restarted gateway — are picked up promptly.
  const waiting = phase === "updating" || phase === "restarting";
  const status = useStatus({ refetchInterval: waiting ? 1_500 : 60_000 });
  const statusVersion = status.data?.version;
  const statusSha = statusVersion?.git.sha ?? null;
  const statusPid = status.data?.pid ?? null;
  const updateSupported = statusVersion?.update.supported === true;

  // The gateway and web server restart independently and can come up in
  // either order, so /status (proxied to the gateway) can't vouch for the web
  // server it transited: a poll can reach the NEW gateway through the
  // still-alive OLD web server. Poll the web-local __healthz route alongside
  // status while waiting so the web server proves its own identity. `ppid` —
  // not the worker pid — is that identity: see the route. retry: false keeps
  // the cadence on the refetch interval while the server is down instead of
  // stretching each cycle through exponential retry backoff.
  const healthz = useQuery({
    queryKey: ["web", "healthz"],
    queryFn: () => api<{ ppid?: number }>("/__healthz"),
    enabled: waiting,
    refetchInterval: 1_500,
    retry: false
  });
  const healthzPpid = typeof healthz.data?.ppid === "number" ? healthz.data.ppid : null;

  // Progress poll: while waiting, ask the gateway whether its single-flight
  // update is still running. Only an affirmative answer feeds the deadline
  // extension below; retry: false keeps failed polls on the interval cadence
  // (and a failed poll extends nothing by construction — dataUpdatedAt only
  // advances on success).
  const progress = useQuery({
    queryKey: ["version", "progress"],
    queryFn: () => api<{ updateInProgress?: boolean }>("/version"),
    enabled: waiting,
    refetchInterval: progressPollIntervalMs,
    retry: false
  });

  // Each fresh `updateInProgress: true` answer pushes the stall deadline out
  // to at least now + progressExtendMs, never past the hard cap. Keyed on
  // dataUpdatedAt so only a NEW successful poll extends: `false`, errors,
  // and a silent gateway leave the deadline where it was, so a hung update
  // still releases on the fixed-deadline fallback exactly as before. The
  // retained `true` from a previous poll can re-run this on a phase flip,
  // which is harmless: at gate start the remaining time exceeds the
  // extension, so max() keeps the base deadline.
  const progressUpdatedAt = progress.dataUpdatedAt;
  const progressInFlight = progress.data?.updateInProgress === true;
  useEffect(() => {
    if (!waiting || !progressInFlight) return;
    if (stallDeadlineRef.current == null || hardCapRef.current == null) return;
    const extended = Math.min(hardCapRef.current, Math.max(stallDeadlineRef.current, Date.now() + progressExtendMs));
    if (extended === stallDeadlineRef.current) return;
    stallDeadlineRef.current = extended;
    setDeadlineExtensions((n) => n + 1);
  }, [waiting, progressInFlight, progressUpdatedAt, progressExtendMs]);

  const versionCheck = useQuery({
    queryKey: ["version", "check"],
    queryFn: () => api<GiniVersionInfo>("/update/check", { method: "POST" }),
    enabled: updateSupported && phase === "idle",
    refetchInterval: 5 * 60_000
  });
  const version = versionCheck.data ?? statusVersion;
  const updateAvailable = version?.git.updateAvailable === true;

  const reset = useCallback(() => {
    // The owner's exit is broadcast so follower tabs don't sit blurred
    // behind their own deadlines after an update that ends without a
    // restart (upToDate, a structured pre-flight error, a stall release).
    if (ownerRef.current) channelRef.current?.postMessage({ type: "done" });
    ownerRef.current = false;
    startedAtRef.current = null;
    setPhase("idle");
    setTargetSha(null);
    setBeforeSha(null);
    setBeforePid(null);
    setBeforeWebPpid(null);
    setRestartExpected(true);
    setRestartingSince(null);
    writePersistedGate(null);
  }, []);

  const update = useMutation({
    mutationFn: () => api<GiniUpdateResult>("/update", { method: "POST" }),
    onSuccess: (result) => {
      if (result.upToDate) {
        reset();
        toast.success("Gini is already current");
        qc.invalidateQueries({ queryKey: ["status"] });
        qc.invalidateQueries({ queryKey: ["version", "check"] });
        return;
      }
      // Keep the gate up; now wait for status to report this sha. Default to
      // expecting a restart when the result omits the field (an older gateway
      // build serving the POST) — every shipped non-upToDate path schedules one.
      const expectRestart = result.restart?.requested ?? true;
      setTargetSha(result.afterSha);
      setRestartExpected(expectRestart);
      writePersistedGate({
        phase: "updating",
        targetSha: result.afterSha,
        beforeSha: beforeSha ?? undefined,
        beforePid: beforePid ?? undefined,
        beforeWebPpid: beforeWebPpid ?? undefined,
        restartExpected: expectRestart,
        startedAt: startedAtRef.current ?? undefined
      });
    },
    onError: (error: Error) => {
      // Release the blur only on a structured gateway error — the gateway
      // itself responded non-2xx (a genuine pre-flight failure). Everything
      // else means the gateway most likely applied the update and restarted
      // before the response flushed: keep the blur and let the new-revision
      // detector / stall timer resolve it rather than handing the app back
      // mid-update. That includes BOTH unreachable shapes api() can throw —
      // the BFF's gateway_unreachable 503 (the gateway died mid-POST and the
      // BFF answered for it) and a tagged transport/parse failure. Checking
      // `status` alone would mistake the BFF's 503 for a gateway response
      // and release the gate in exactly the window it exists to cover.
      const { status, unreachable } = error as ApiError;
      if (typeof status === "number" && !unreachable) {
        // One structured error must NOT release: the gateway's single-flight
        // guard answers 409 when another tab's POST won the race inside the
        // broadcast latency. An update IS running — just not this tab's — so
        // a reset() here would broadcast {type:"done"} and unblur every
        // follower while the winner's update is mid-flight. Demote this tab
        // to follower instead: keep the blur (and its engage-time baselines)
        // and finish through the follower completion detection.
        if (status === 409) {
          ownerRef.current = false;
          return;
        }
        reset();
        toast.error(error.message);
      }
    }
  });
  const { mutate, isPending } = update;

  // Engage the gate in this tab. The owner (the tab whose update control was
  // clicked) additionally broadcasts the start to sibling tabs and fires the
  // POST; a follower (engaged by that broadcast) runs everything else — the
  // same baseline capture, persistence, completion detection, and deadline
  // rules — and probe-then-reloads itself on completion. Either way the blur
  // goes up immediately: the POST itself (git + bun install + build) is the
  // slow part, so the gate must not wait for it.
  const engage = useCallback((owner: boolean) => {
    if (phase !== "idle") return;
    ownerRef.current = owner;
    startedAtRef.current = Date.now();
    setBeforeSha(statusSha);
    setBeforePid(statusPid);
    setPhase("updating");
    writePersistedGate({
      phase: "updating",
      beforeSha: statusSha ?? undefined,
      beforePid: statusPid ?? undefined,
      startedAt: startedAtRef.current
    });
    // Capture the web server's tree identity (ppid) once, in parallel with
    // the POST. The POST takes seconds (git + install), so this settles long
    // before any restart; if it fails, the web leg degrades to its time-based
    // fallback.
    setBeforeWebPpid(null);
    api<{ ppid?: number }>("/__healthz")
      .then((h) => setBeforeWebPpid(typeof h.ppid === "number" ? h.ppid : null))
      .catch(() => {});
    if (owner) {
      channelRef.current?.postMessage({ type: "start" });
      mutate();
    }
  }, [phase, statusSha, statusPid, mutate]);

  const start = useCallback(() => engage(true), [engage]);

  // Cross-tab messages, dispatched through a render-refreshed ref so the
  // mount effect below subscribes once without re-opening the channel every
  // time phase or engage identity changes. (Null only before first render's
  // assignment below, which precedes every effect and message.)
  const onGateMessageRef = useRef<((data: unknown) => void) | null>(null);
  onGateMessageRef.current = (data: unknown) => {
    const type = (data as { type?: unknown } | null)?.type;
    // A sibling tab started an update: blur here too, in follower mode.
    if (type === "start") engage(false);
    // The owner's update ended. A follower still in "updating" — the sha
    // never moved, so the update released without a restart (upToDate, a
    // pre-flight failure, a stall) — releases with it; one already in
    // "restarting"/"complete" ignores the message and finishes through its
    // own detection + probe-then-reload, which is what lands it on the
    // freshly built assets.
    if (type === "done" && !ownerRef.current && phase === "updating") reset();
  };

  // Open the cross-tab channel once per mount. The factory is read through a
  // ref so an inline prop value can't churn the subscription.
  const createGateChannelRef = useRef(createGateChannel);
  createGateChannelRef.current = createGateChannel;
  useEffect(() => {
    const channel = createGateChannelRef.current();
    if (!channel) return;
    channelRef.current = channel;
    channel.onmessage = (event) => onGateMessageRef.current?.(event.data);
    return () => {
      channelRef.current = null;
      channel.close();
    };
  }, []);

  // Resume an in-flight gate after a restart-triggered reload. Only a
  // verified complete (written after reachability was proven) may resume into
  // "complete" — and even then the pre-reload probe re-checks the web server
  // before reloading. A persisted complete without the marker — one written
  // before the stack proved it restarted — re-enters "restarting" and proves
  // reachability first.
  useEffect(() => {
    const persisted = readPersistedGate();
    if (!persisted) return;
    // Restore the original gate start FIRST (every resumed shape needs it):
    // the stall effect anchors the deadline and hard cap on it, so a resume
    // must not re-arm them from "now". A legacy gate without it falls back
    // to anchoring at the resume.
    startedAtRef.current = persisted.startedAt ?? null;
    if (persisted.phase === "complete" && persisted.verified) {
      setPhase("complete");
      return;
    }
    setTargetSha(persisted.targetSha ?? null);
    setBeforeSha(persisted.beforeSha ?? null);
    setBeforePid(persisted.beforePid ?? null);
    setBeforeWebPpid(persisted.beforeWebPpid ?? null);
    setRestartExpected(persisted.restartExpected ?? true);
    setPhase(persisted.phase === "complete" ? "restarting" : persisted.phase);
  }, []);

  // Status reports the new revision → the update landed on disk. Match the
  // explicit target when we have it; otherwise (a reload interrupted the POST)
  // fall back to "HEAD moved off the starting revision". The fallback is gated
  // on the POST having settled so a status poll during the slow POST — when
  // HEAD has been reset on disk but the runtime is still installing — can't
  // advance the gate early. The new sha alone does NOT mean the new stack is
  // up: version info is read from git per request, so the still-running OLD
  // gateway reports it immediately while the restart is about to tear both
  // servers down. When a restart is coming, hold in "restarting" until both
  // restarted servers answer; only a restart-free update may complete here.
  useEffect(() => {
    if (phase !== "updating" || !statusSha) return;
    const matchedTarget = targetSha != null && statusSha === targetSha;
    const movedOffStart = !isPending && beforeSha != null && statusSha !== beforeSha;
    if (!matchedTarget && !movedOffStart) return;
    if (restartExpected) {
      setPhase("restarting");
      writePersistedGate({
        phase: "restarting",
        beforePid: beforePid ?? undefined,
        beforeWebPpid: beforeWebPpid ?? undefined,
        startedAt: startedAtRef.current ?? undefined
      });
    } else {
      // No restart scheduled → the servers never go down, so this complete
      // is verified by construction.
      setPhase("complete");
      writePersistedGate({ phase: "complete", verified: true, startedAt: startedAtRef.current ?? undefined });
    }
  }, [phase, targetSha, beforeSha, statusSha, isPending, restartExpected, beforePid, beforeWebPpid]);

  // Wall-clock the moment the gate began waiting on the restart; consumed only
  // by the pid-less fallbacks in the completion detector below.
  useEffect(() => {
    if (phase === "restarting") setRestartingSince(Date.now());
  }, [phase]);

  // The restarting phase completes only once BOTH halves of the stack prove
  // they restarted — they bounce independently, so neither vouches for the
  // other. A status poll can reach the NEW gateway through the still-alive
  // OLD web server (the gateway respawns in well under a second while the web
  // kickstart is still in flight), so the gateway pid flipping alone must not
  // release the reload onto a web server that's about to die.
  //   - Gateway leg: /status reports a pid different from beforePid. Cached
  //     query data still carries the old pid, so a differing pid is
  //     intrinsically a fresh post-restart response.
  //   - Web leg: the local __healthz route reports a ppid different from
  //     beforeWebPpid — proof the web server TREE was replaced. The worker
  //     pid would lie here: the next CLI respawns its worker (new pid, same
  //     still-old tree) when an update's checkout touches next.config.*, but
  //     the supervising ppid only changes on a kickstart / stop+start.
  // Each leg falls back when its starting identity is unknown (a gate
  // persisted by an older page, or the probe failing/omitting the field): the
  // first poll on that query that succeeds after entering this phase —
  // reachability without identity, with a residual race against the dying old
  // stack that's acceptable for the degraded path. dataUpdatedAt only
  // advances on success and each query retains its last data, so a satisfied
  // leg stays satisfied while the other catches up. While the servers are
  // down the polls just reject; react-query keeps refetching on the interval.
  const statusUpdatedAt = status.dataUpdatedAt;
  const healthzUpdatedAt = healthz.dataUpdatedAt;
  // While the gateway's LATEST progress answer reports the update still
  // running, the time-based fallback legs must not latch: the restart
  // hasn't happened, so any poll that succeeds now succeeded against the
  // still-old stack. The exposure is a gate with BOTH baselines unknown —
  // a follower engages without a pending POST, so it can sit in
  // "restarting" minutes before the real restart, and the first successful
  // polls would otherwise complete it onto stale assets. The identity legs
  // stay as-is (a flipped pid/ppid is restart proof regardless). A `false`
  // answer or a poll failure newer than the last success (errorUpdatedAt
  // past dataUpdatedAt) drops the hold and the plain fallback resumes.
  const progressHoldsFallback = progressInFlight && progress.errorUpdatedAt <= progress.dataUpdatedAt;
  useEffect(() => {
    if (phase !== "restarting") return;
    const gatewayRestarted =
      beforePid != null
        ? statusPid != null && statusPid !== beforePid
        : !progressHoldsFallback && restartingSince != null && statusUpdatedAt > restartingSince;
    const webRestarted =
      beforeWebPpid != null
        ? healthzPpid != null && healthzPpid !== beforeWebPpid
        : !progressHoldsFallback && restartingSince != null && healthzUpdatedAt > restartingSince;
    if (gatewayRestarted && webRestarted) {
      setPhase("complete");
      writePersistedGate({ phase: "complete", verified: true, startedAt: startedAtRef.current ?? undefined });
    }
  }, [phase, beforePid, statusPid, beforeWebPpid, healthzPpid, restartingSince, statusUpdatedAt, healthzUpdatedAt, progressHoldsFallback]);

  // Once complete, reload onto the fresh assets — after one last __healthz
  // probe. The identity proofs above are point-in-time: the web server can
  // still go down between the proving poll and this reload (a crash, or a
  // worker respawn mid-flight), and reloading into that window strands the
  // browser on a connection error with the gate gone. So probe once right
  // before reloading — no retries, short timeout, the reload is the
  // time-sensitive part — and on failure drop back to "restarting", where the
  // phase-entry effect re-arms restartingSince and the detectors take over
  // again. A resumed verified-complete gate passes through here too, so its
  // pre-reload proof never predates the reload that resumed it. Clear the
  // persisted gate only on the success path so the reloaded page comes up
  // clean.
  useEffect(() => {
    if (phase !== "complete") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api("/__healthz", { signal: AbortSignal.timeout(5_000) })
        .then(() => {
          if (cancelled) return;
          // Completion side of the cross-tab contract (see GATE_CHANNEL_NAME):
          // the owner announces the update is over right before reloading.
          if (ownerRef.current) channelRef.current?.postMessage({ type: "done" });
          writePersistedGate(null);
          window.location.reload();
        })
        .catch(() => {
          if (cancelled) return;
          setPhase("restarting");
          writePersistedGate({
            phase: "restarting",
            beforePid: beforePid ?? undefined,
            beforeWebPpid: beforeWebPpid ?? undefined,
            startedAt: startedAtRef.current ?? undefined
          });
        });
    }, COMPLETE_RELOAD_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, beforePid, beforeWebPpid]);

  // Safety net spanning every non-idle phase: release if the update never
  // reloads (a hung POST, a failed restart, a reload that lost the target
  // revision, or a stack that proved its restart and then died — the latter
  // cycles complete ↔ restarting on pre-reload probe failures because the
  // latched identity legs re-complete the gate instantly). The deadline is
  // set when the gate leaves idle: phase changes re-run this effect, but
  // each run schedules the remaining time against the one shared deadline,
  // so transitions and drop-backs cannot extend the blur. Only the progress
  // poll above moves the deadline — each move bumps deadlineExtensions so
  // this effect re-arms against it — and its hard cap (fixed here alongside
  // the deadline) bounds the whole gate absolutely. Releasing from
  // "complete" also tears down the pending probe/reload via that effect's
  // cancelled-flag cleanup.
  useEffect(() => {
    if (phase === "idle") {
      stallDeadlineRef.current = null;
      hardCapRef.current = null;
      return;
    }
    // Anchor both on the gate's first start — the persisted one for a
    // resumed gate — so a mid-update reload cannot re-arm the deadline or
    // the hard cap from "now".
    stallDeadlineRef.current ??= (startedAtRef.current ?? Date.now()) + stallTimeoutMs;
    hardCapRef.current ??= (startedAtRef.current ?? Date.now()) + gateHardCapMs;
    const timer = setTimeout(() => {
      reset();
      toast.error("Update is taking longer than expected. Reload to check on it.");
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["version", "check"] });
    }, stallDeadlineRef.current - Date.now());
    return () => clearTimeout(timer);
  }, [phase, reset, qc, stallTimeoutMs, gateHardCapMs, deadlineExtensions]);

  const value = useMemo<UpdateGateValue>(
    () => ({ version, updateSupported, updateAvailable, phase, start }),
    [version, updateSupported, updateAvailable, phase, start]
  );

  return (
    <UpdateGateContext.Provider value={value}>
      {/* `inert` while a gate is up makes the whole app unreachable — not just
          unclickable behind the overlay, but un-tabbable for keyboard users.
          display:contents keeps the wrapper out of layout. */}
      <div className="contents" inert={phase !== "idle"}>
        {children}
      </div>
      {phase !== "idle" ? <UpdateOverlay phase={phase} /> : null}
    </UpdateGateContext.Provider>
  );
}

const OVERLAY_COPY: Record<Exclude<UpdatePhase, "idle">, { title: string; detail: string }> = {
  updating: {
    title: "Updating Gini",
    detail: "Gini is updating. The app will be unavailable until it finishes."
  },
  restarting: {
    title: "Restarting Gini",
    detail: "Gini is restarting onto the new version…"
  },
  complete: {
    title: "Update complete",
    detail: "Reloading the app…"
  }
};

// Full-viewport blur that blocks all interaction while an update is applied
// and the stack restarts, then confirms completion before the reload. Rendered
// at the provider root so it covers the sidebar and main pane alike.
function UpdateOverlay({ phase }: { phase: Exclude<UpdatePhase, "idle"> }) {
  const complete = phase === "complete";
  const copy = OVERLAY_COPY[phase];
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-busy={!complete}
      aria-label={copy.title}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-md"
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-popover/95 px-8 py-7 text-center shadow-2xl">
        {complete ? (
          <CheckCircle2 className="size-7 text-emerald-500" />
        ) : (
          <Loader2 className="size-7 animate-spin text-muted-foreground" />
        )}
        <div className="text-sm font-semibold text-popover-foreground">{copy.title}</div>
        <div className="max-w-[240px] text-xs text-muted-foreground">{copy.detail}</div>
      </div>
    </div>
  );
}
