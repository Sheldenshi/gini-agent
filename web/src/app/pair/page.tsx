"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  cancelPairingRequest,
  claimPairingRequest,
  createPairingRequest,
  pollPairingRequest
} from "@/lib/pairing";

// The standalone /pair page an UNPAIRED device lands on. When a device opens
// the relay URL without a session cookie the gateway redirects every page-nav
// here. We create a pairing request, render its code as the hero, and poll
// until the operator approves it on the loopback front. On approval we claim
// the request (which sets the gini_session cookie) and reload into the app.
//
// This page is deliberately self-contained: it talks only to @/lib/pairing
// (same-origin /api/pairing/*) and depends on nothing from the runtime/app
// data layer, so it renders even though the device has no session yet.

// UI phases drive the in-place swap inside the single card. "pending" covers
// both the initial create and the steady-state poll; the others are terminal
// (a fresh request resets back to "creating").
type Phase =
  | "creating"
  | "create-error"
  | "pending"
  | "claiming"
  | "paired"
  | "rejected"
  | "expired"
  | "claim-error"
  | "cancelled";

const POLL_INTERVAL_MS = 2000;

export default function PairPage() {
  const [phase, setPhase] = useState<Phase>("creating");
  const [id, setId] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Holds the active poll interval so we can clear it on unmount, on reaching a
  // terminal phase, or before starting a fresh request.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Guards the mount effect against React Strict Mode (Next dev) double-invoking
  // it, which would otherwise fire two POST /api/pairing/request — orphaning one
  // pending slot and racing two codes/cookies. User-initiated retries call
  // startRequest directly and are unaffected.
  const createdRef = useRef(false);

  // Flipped false synchronously by cancel() (before any await) so an in-flight
  // poll/claim tick that resumes during the cancel round-trip can't pair the
  // device after the user clicked Cancel. startRequest re-arms it.
  const activeRef = useRef(true);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Create (or recreate) a pairing request and arm the poll loop. Any prior
  // poll is torn down first so we never run two loops at once.
  const startRequest = useCallback(async () => {
    stopPolling();
    activeRef.current = true;
    setError(null);
    setId(null);
    setCode(null);
    setPhase("creating");
    try {
      const request = await createPairingRequest();
      setId(request.id);
      setCode(request.code);
      setPhase("pending");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("create-error");
    }
  }, [stopPolling]);

  // Mount once: kick off the first request. The createdRef guard makes this
  // exactly-once even under Strict Mode's double mount in dev.
  useEffect(() => {
    if (createdRef.current) return;
    createdRef.current = true;
    void startRequest();
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drive the poll loop while pending. The poller reads the freshest id from
  // the closure created when we entered "pending" (id is set in the same render
  // path), so this effect depends on both phase and id.
  useEffect(() => {
    if (phase !== "pending" || !id) return;

    let cancelled = false;

    const tick = async () => {
      try {
        const { status } = await pollPairingRequest(id);
        if (cancelled || !activeRef.current) return;
        if (status === "approved") {
          // Hand off to the dedicated claim effect below. We must NOT claim
          // inline here: setPhase("claiming") re-runs THIS effect, whose
          // cleanup sets `cancelled = true`, which would then abort the
          // post-claim reload even though the claim succeeded.
          stopPolling();
          setPhase("claiming");
          return;
        }
        if (status === "rejected") {
          stopPolling();
          setPhase("rejected");
        } else if (status === "expired") {
          stopPolling();
          setPhase("expired");
        } else if (status === "cancelled") {
          stopPolling();
          setPhase("cancelled");
        } else if (status === "claimed") {
          // We're polling (not mid-claim — polling stops the instant we see
          // "approved", before the claim effect runs), yet the request is already
          // claimed. That means a prior claim committed but its one-time token
          // never reached us (lost response / a reload before the gini_session
          // cookie landed). The token is unrecoverable, so surface a restartable
          // state instead of spinning forever.
          stopPolling();
          setError("This pairing was already completed. Start a new one.");
          setPhase("claim-error");
        }
        // "pending" → keep waiting.
      } catch (e) {
        if (cancelled || !activeRef.current) return;
        // A 404 (request gone/expired), 403 (binding mismatch — e.g. another
        // /pair tab overwrote this browser's gini_pair cookie), or 401 (the
        // gini_pair binding cookie is missing/dropped/expired, so the poll can
        // never succeed) is terminal for THIS request: stop polling and surface a
        // restartable state instead of spinning forever. Any other failure is a
        // transient relay blip — retry.
        const httpStatus = (e as { status?: number } | null)?.status;
        if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
          stopPolling();
          setError("This pairing request is no longer valid. Start a new one.");
          setPhase("claim-error");
        }
      }
    };

    pollRef.current = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [phase, id, stopPolling]);

  // Claim runs in its OWN effect, entered when the poll flips us to "claiming".
  // It is deliberately separate from the poll effect: doing the claim inside the
  // poll tick self-cancelled, because setPhase("claiming") re-runs the poll
  // effect and its cleanup sets that tick's `cancelled` flag — so the post-claim
  // reload never fired even though the claim (and the gini_session cookie) had
  // succeeded. Here, nothing mutates [phase, id] during the claim await, so the
  // success path always completes.
  useEffect(() => {
    if (phase !== "claiming" || !id) return;
    let cancelled = false;
    void (async () => {
      try {
        await claimPairingRequest(id);
        if (cancelled || !activeRef.current) return;
        setPhase("paired");
        // The claim set the gini_session cookie; a full reload re-enters the
        // app authenticated instead of bouncing back to /pair.
        window.location.assign("/");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("claim-error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, id]);

  const cancel = useCallback(async () => {
    // Disarm synchronously, before any await, so a poll/claim tick already
    // mid-flight bails instead of pairing the device after this cancel.
    activeRef.current = false;
    stopPolling();
    if (!id) {
      setPhase("cancelled");
      return;
    }
    try {
      await cancelPairingRequest(id);
    } catch {
      // The request may already be terminal server-side; either way we surface
      // the cancelled state locally.
    }
    setPhase("cancelled");
  }, [id, stopPolling]);

  const codeDimmed = phase === "expired" || phase === "cancelled";

  return (
    <div className="grid min-h-screen place-items-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-6 rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-lg font-semibold">Pair this device</h1>
          <p className="text-sm text-muted-foreground">
            Make sure this code matches the one on your computer, then approve it there.
          </p>
        </div>

        {code ? (
          <div
            className={cnChip(codeDimmed)}
            aria-label="Pairing code"
          >
            {code}
          </div>
        ) : (
          <div className="grid h-[4.5rem] w-full place-items-center">
            {phase === "create-error" ? (
              <XCircle className="h-7 w-7 text-destructive" />
            ) : (
              <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
            )}
          </div>
        )}

        <StatusRow phase={phase} error={error} />

        <Controls
          phase={phase}
          onRetryCreate={() => void startRequest()}
          onTryAgain={() => void startRequest()}
          onCancel={() => void cancel()}
        />
      </div>
    </div>
  );
}

function cnChip(dimmed: boolean): string {
  const base =
    "rounded-lg border bg-muted/30 px-6 py-4 text-3xl font-mono tracking-[0.3em] sm:text-4xl";
  return dimmed ? `${base} opacity-40` : base;
}

function StatusRow({ phase, error }: { phase: Phase; error: string | null }) {
  switch (phase) {
    case "creating":
      return (
        <Status icon={<Spinner />} text="Generating your code…" />
      );
    case "create-error":
      return (
        <Status
          tone="error"
          text={error ?? "Couldn't start pairing."}
        />
      );
    case "pending":
      return (
        <Status icon={<Spinner />} text="Waiting for approval on your computer…" />
      );
    case "claiming":
      return <Status icon={<Spinner />} text="Approved — finishing up…" />;
    case "paired":
      return (
        <Status
          tone="success"
          icon={<CheckCircle2 className="h-5 w-5 text-emerald-500" />}
          text="Paired — taking you in…"
        />
      );
    case "rejected":
      return (
        <Status
          tone="error"
          icon={<XCircle className="h-5 w-5 text-destructive" />}
          text="Request denied"
        />
      );
    case "expired":
      return <Status tone="muted" text="This code expired" />;
    case "claim-error":
      return (
        <Status
          tone="error"
          icon={<XCircle className="h-5 w-5 text-destructive" />}
          text={error ?? "Pairing couldn't be completed."}
        />
      );
    case "cancelled":
      return <Status tone="muted" text="Pairing cancelled" />;
  }
}

type Tone = "default" | "success" | "error" | "muted";

function Status({
  icon,
  text,
  tone = "default"
}: {
  icon?: React.ReactNode;
  text: string;
  tone?: Tone;
}) {
  const toneClass =
    tone === "error"
      ? "text-destructive"
      : tone === "success"
        ? "text-emerald-500"
        : tone === "muted"
          ? "text-muted-foreground"
          : "text-foreground";
  return (
    <div className={`flex min-h-[1.5rem] items-center justify-center gap-2 text-sm ${toneClass}`}>
      {icon}
      <span>{text}</span>
    </div>
  );
}

function Spinner() {
  return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
}

function Controls({
  phase,
  onRetryCreate,
  onTryAgain,
  onCancel
}: {
  phase: Phase;
  onRetryCreate: () => void;
  onTryAgain: () => void;
  onCancel: () => void;
}) {
  switch (phase) {
    case "create-error":
      return (
        <Button variant="default" onClick={onRetryCreate}>
          Try again
        </Button>
      );
    case "pending":
    case "claiming":
      return (
        <Button variant="ghost" onClick={onCancel} disabled={phase === "claiming"}>
          Cancel
        </Button>
      );
    case "rejected":
    case "claim-error":
      return (
        <Button variant="default" onClick={onTryAgain}>
          Try again
        </Button>
      );
    case "expired":
      return (
        <Button variant="default" onClick={onTryAgain}>
          Start over
        </Button>
      );
    case "cancelled":
      return (
        <Button variant="default" onClick={onTryAgain}>
          Pair again
        </Button>
      );
    case "creating":
    case "paired":
      return null;
  }
}
