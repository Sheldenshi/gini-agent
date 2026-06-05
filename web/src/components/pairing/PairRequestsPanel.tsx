"use client";

import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  usePairingRequests,
  useApprovePairing,
  useRejectPairing,
  type PairingRequestView
} from "@/lib/pairing";
import { Button } from "@/components/ui/button";

/**
 * Compact relative-time label for a request's createdAt. Pairing requests live
 * for minutes, so seconds/minutes granularity is all the operator needs to tell
 * a stale request from a fresh one — no date library required.
 */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

/**
 * The admin "Pair requests" list. Shown to any PAIRED session — loopback OR a
 * relay browser paired earlier — both of which are admins that can approve/add
 * devices (see ADR device-pairing-auth.md, "Relay sessions mirror loopback").
 * It mounts only inside the (open-gated) Pair-device dialog, itself reachable
 * only by a paired/loopback session, so there is no front to gate on here.
 *
 * The list polls every 3s as a backstop (see usePairingRequests). Instant SSE
 * refresh is handled app-wide by RuntimeStreamBridge, which invalidates
 * ["pairingRequests"]/["devices"] on every "pairing" event — so this panel does
 * not subscribe to the stream itself (it only ever mounts on routes where the
 * bridge is active).
 */
export function PairRequestsPanel() {
  const { data: requests = [] } = usePairingRequests();
  const approve = useApprovePairing();
  const reject = useRejectPairing();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold leading-none">Pair requests</span>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60 motion-reduce:animate-none" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          Listening…
        </span>
      </div>

      {requests.length === 0 ? (
        <div className="grid place-items-center gap-1 rounded-lg border border-border bg-muted/20 px-3 py-6 text-center">
          <p className="text-sm font-medium text-muted-foreground">
            Waiting for a device to scan…
          </p>
          <p className="text-xs text-muted-foreground">
            Open the link or scan the code on the device you want to add.
          </p>
        </div>
      ) : (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto overscroll-contain rounded-lg border border-border">
          {requests.map((item) => (
            <PairRequestRow
              key={item.id}
              item={item}
              approving={approve.isPending}
              rejecting={reject.isPending}
              onApprove={() =>
                approve.mutate(item.id, {
                  onSuccess: () => toast.success("Device approved"),
                  onError: (error) => toast.error(error.message)
                })
              }
              onReject={() =>
                reject.mutate(item.id, {
                  onSuccess: () => toast.success("Request rejected"),
                  onError: (error) => toast.error(error.message)
                })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PairRequestRow({
  item,
  approving,
  rejecting,
  onApprove,
  onReject
}: {
  item: PairingRequestView;
  approving: boolean;
  rejecting: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    // The warning spans the FULL row width below the code+actions line. Keying the
    // old two-column layout off `sm:` broke here: `sm:` is the viewport width, not
    // this row's, so inside the narrow tunnel popover the warning was squeezed into
    // a thin left column beside the buttons (a big empty gap on the right). A
    // top row (code/device left, actions right) + a full-width warning works in
    // both the narrow popover and the wider settings dialog.
    <li className="space-y-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="font-mono text-2xl font-semibold tracking-widest text-foreground tabular-nums">
            {item.code}
          </div>
          <div className="text-xs text-muted-foreground">
            <span className="text-foreground">{item.deviceName}</span>
            {" · "}
            {relativeTime(item.createdAt)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onReject} disabled={rejecting}>
            Reject
          </Button>
          <Button variant="default" size="sm" onClick={onApprove} disabled={approving}>
            Approve
          </Button>
        </div>
      </div>
      <div className="flex items-start gap-1.5 text-xs text-amber-500 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Approve only if this code matches the one shown on that device.</span>
      </div>
    </li>
  );
}
