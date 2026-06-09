"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useStatus } from "@/lib/queries";
import type { GiniUpdateResult, GiniVersionInfo } from "@runtime/types";

type UpdatePhase = "idle" | "updating" | "complete";

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
  phase: "updating" | "complete";
  // The revision the runtime should report once the update lands. Set after the
  // POST returns; absent if a reload interrupts the POST.
  targetSha?: string;
  // The revision when the update started. Lets a resumed gate detect completion
  // by "HEAD moved" even without a targetSha.
  beforeSha?: string;
}

function readPersistedGate(): PersistedGate | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedGate;
    if (parsed.phase === "updating" || parsed.phase === "complete") return parsed;
    return null;
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

// Hold the "complete" confirmation on screen this long before reloading onto the
// freshly built assets.
const COMPLETE_RELOAD_DELAY_MS = 1_500;
// Generous ceiling for the whole update (git + bun install in both roots, then
// the restart). If the runtime never reports the new revision within this, the
// gate releases rather than trapping the user behind a permanent blur. The
// completion detector normally tears the gate down long before this fires.
const STALL_TIMEOUT_MS = 120_000;

export function UpdateGateProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [targetSha, setTargetSha] = useState<string | null>(null);
  const [beforeSha, setBeforeSha] = useState<string | null>(null);

  // Poll status fast while updating so the new revision is picked up promptly.
  const status = useStatus({ refetchInterval: phase === "updating" ? 1_500 : 60_000 });
  const statusVersion = status.data?.version;
  const statusSha = statusVersion?.git.sha ?? null;
  const updateSupported = statusVersion?.update.supported === true;

  const versionCheck = useQuery({
    queryKey: ["version", "check"],
    queryFn: () => api<GiniVersionInfo>("/update/check", { method: "POST" }),
    enabled: updateSupported && phase === "idle",
    refetchInterval: 5 * 60_000
  });
  const version = versionCheck.data ?? statusVersion;
  const updateAvailable = version?.git.updateAvailable === true;

  const reset = useCallback(() => {
    setPhase("idle");
    setTargetSha(null);
    setBeforeSha(null);
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
      // Keep the gate up; now wait for the restarted runtime to report this sha.
      setTargetSha(result.afterSha);
      writePersistedGate({ phase: "updating", targetSha: result.afterSha, beforeSha: beforeSha ?? undefined });
    },
    onError: (error: Error) => {
      // A dropped connection (fetch rejects with TypeError) most likely means
      // the gateway applied the update and restarted before the response could
      // flush. Keep the blur up and let the new-revision detector / stall timer
      // resolve it rather than handing the app back mid-update. A structured
      // gateway error is a genuine pre-flight failure → release and surface it.
      if (error instanceof TypeError) return;
      reset();
      toast.error(error.message);
    }
  });
  const { mutate, isPending } = update;

  const start = useCallback(() => {
    if (phase !== "idle") return;
    // Blur immediately on click — the POST itself (git + bun install) is the
    // slow part, so the gate must go up before awaiting it.
    setBeforeSha(statusSha);
    setPhase("updating");
    writePersistedGate({ phase: "updating", beforeSha: statusSha ?? undefined });
    mutate();
  }, [phase, statusSha, mutate]);

  // Resume an in-flight gate after a restart-triggered reload.
  useEffect(() => {
    const persisted = readPersistedGate();
    if (!persisted) return;
    if (persisted.phase === "complete") {
      setPhase("complete");
      return;
    }
    setTargetSha(persisted.targetSha ?? null);
    setBeforeSha(persisted.beforeSha ?? null);
    setPhase("updating");
  }, []);

  // The restarted runtime reports the new revision → the update landed. Match
  // the explicit target when we have it; otherwise (a reload interrupted the
  // POST) fall back to "HEAD moved off the starting revision". The fallback is
  // gated on the POST having settled so a status poll during the slow POST —
  // when HEAD has been reset on disk but the runtime is still installing —
  // can't complete the gate early.
  useEffect(() => {
    if (phase !== "updating" || !statusSha) return;
    const matchedTarget = targetSha != null && statusSha === targetSha;
    const movedOffStart = !isPending && beforeSha != null && statusSha !== beforeSha;
    if (matchedTarget || movedOffStart) {
      setPhase("complete");
      writePersistedGate({ phase: "complete" });
    }
  }, [phase, targetSha, beforeSha, statusSha, isPending]);

  // Once complete, reload onto the fresh assets. Clear the persisted gate first
  // so the reloaded page comes up clean.
  useEffect(() => {
    if (phase !== "complete") return;
    const timer = setTimeout(() => {
      writePersistedGate(null);
      window.location.reload();
    }, COMPLETE_RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // Safety net spanning the whole updating phase: release if the update never
  // reports back (a hung POST, a failed restart, or a reload that lost the
  // target revision). Status polling doesn't reset this — its deps are stable
  // while updating — so it fires once, STALL_TIMEOUT_MS after the gate goes up.
  useEffect(() => {
    if (phase !== "updating") return;
    const timer = setTimeout(() => {
      reset();
      toast.error("Update is taking longer than expected. Reload to check on it.");
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["version", "check"] });
    }, STALL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, reset, qc]);

  const value = useMemo<UpdateGateValue>(
    () => ({ version, updateSupported, updateAvailable, phase, start }),
    [version, updateSupported, updateAvailable, phase, start]
  );

  const active = phase !== "idle";
  return (
    <UpdateGateContext.Provider value={value}>
      {/* `inert` while a gate is up makes the whole app unreachable — not just
          unclickable behind the overlay, but un-tabbable for keyboard users.
          display:contents keeps the wrapper out of layout. */}
      <div className="contents" inert={active}>
        {children}
      </div>
      {active ? <UpdateOverlay complete={phase === "complete"} /> : null}
    </UpdateGateContext.Provider>
  );
}

// Full-viewport blur that blocks all interaction while an update is applied,
// then confirms completion before the reload. Rendered at the provider root so
// it covers the sidebar and main pane alike.
function UpdateOverlay({ complete }: { complete: boolean }) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-busy={!complete}
      aria-label={complete ? "Update complete" : "Updating Gini"}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-md"
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#2E2E34] bg-[#101014]/90 px-8 py-7 text-center shadow-2xl">
        {complete ? (
          <CheckCircle2 className="size-7 text-emerald-400" />
        ) : (
          <Loader2 className="size-7 animate-spin text-[#C2C2C8]" />
        )}
        <div className="text-sm font-semibold text-white">
          {complete ? "Update complete" : "Updating Gini"}
        </div>
        <div className="max-w-[240px] text-xs text-[#9A9AA0]">
          {complete
            ? "Reloading the app…"
            : "Gini is updating. The app will be unavailable until it finishes."}
        </div>
      </div>
    </div>
  );
}
