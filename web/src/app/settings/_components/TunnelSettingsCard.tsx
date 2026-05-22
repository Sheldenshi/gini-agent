"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";

interface AppleNotesStatus {
  enabled: boolean | null;
  folder: string | null;
  noteName: string | null;
  available: boolean | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface TunnelSnapshot {
  enabled: boolean | null;
  publicUrl: string | null;
  cloudflareUrl: string | null;
  secret: string | null;
  targetUrl: string | null;
  observedAt: string | null;
  appleNotes: AppleNotesStatus | null;
  lastError: string | null;
}

// Same shape as the existing Toolsets/MCP/Messaging/Devices cards on
// this page: an outline button labeled with the action ("Enable" vs
// "Disable") next to a StatusPill that shows the current state.
// Optimistic mutation flips the cache immediately so the toggle never
// freezes when the click itself severs the response path (disabling
// the tunnel from a page being served through that same tunnel).
export function TunnelSettingsCard() {
  const queryClient = useQueryClient();
  const snapshot = useQuery({
    queryKey: ["tunnel"],
    queryFn: () => api<TunnelSnapshot>("/tunnel"),
    refetchInterval: 5_000
  });
  const [infoOpen, setInfoOpen] = useState(false);

  const tunnelEnabled = snapshot.data?.enabled === true;
  const liveUrl = snapshot.data?.cloudflareUrl ?? null;
  const tunnelStatus = !tunnelEnabled
    ? "disabled"
    : liveUrl
      ? "active"
      : "pending";
  const tunnelDescription = !tunnelEnabled
    ? "Off — the gateway is reachable on localhost only."
    : liveUrl
      ? `Live at ${liveUrl}`
      : "Connecting…";

  const notesAvailable = snapshot.data?.appleNotes?.available;
  const notesEnabled = snapshot.data?.appleNotes?.enabled === true;
  const notesUnavailableReason = notesAvailable === false
    ? snapshot.data?.appleNotes?.lastError ?? "iCloud account not found in Notes.app on this host."
    : null;
  const notesStatus = !tunnelEnabled || !notesEnabled
    ? "disabled"
    : notesUnavailableReason
      ? "error"
      : "active";
  const notesDescription = !tunnelEnabled
    ? "Off — enable the tunnel first."
    : notesUnavailableReason
      ? notesUnavailableReason
      : notesEnabled
        ? snapshot.data?.appleNotes?.lastSyncedAt
          ? `Last synced ${new Date(snapshot.data.appleNotes.lastSyncedAt).toLocaleString()}`
          : "Waiting for the next sync…"
        : "Off";

  // Toggling the tunnel off while the operator is currently accessing the
  // gateway through that same tunnel is inherently self-defeating: the
  // runtime tears cloudflared down before our PATCH gets a response, so
  // the fetch hangs and the button looks frozen. Optimistic updates
  // flip the visible state the instant the user clicks; the PATCH races
  // against a short ceiling so the mutation can't pend forever.
  const toggleTunnel = useMutation({
    mutationFn: async (enabled: boolean) => {
      const fetchPromise = api<TunnelSnapshot>("/tunnel", {
        method: "PATCH",
        body: JSON.stringify({ enabled })
      }).catch(() => null);
      const ceiling = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500));
      return Promise.race([fetchPromise, ceiling]);
    },
    onMutate: async (enabled: boolean) => {
      await queryClient.cancelQueries({ queryKey: ["tunnel"] });
      const previous = queryClient.getQueryData<TunnelSnapshot>(["tunnel"]);
      queryClient.setQueryData<TunnelSnapshot | undefined>(["tunnel"], (old) =>
        old
          ? {
              ...old,
              enabled,
              cloudflareUrl: enabled ? old.cloudflareUrl : null,
              publicUrl: null,
              observedAt: enabled ? old.observedAt ?? new Date().toISOString() : null,
              appleNotes: enabled
                ? old.appleNotes
                : old.appleNotes
                  ? { ...old.appleNotes, lastSyncedAt: null }
                  : null
            }
          : old
      );
      return { previous };
    },
    onSuccess: (_data, enabled) => {
      toast.success(enabled ? "Tunnel enabled" : "Tunnel disabled");
    },
    onError: (error: Error, _enabled, context) => {
      toast.error(error.message);
      if (context?.previous) queryClient.setQueryData(["tunnel"], context.previous);
    }
  });

  const toggleNotes = useMutation({
    mutationFn: async (enabled: boolean) => {
      const fetchPromise = api<TunnelSnapshot>("/tunnel", {
        method: "PATCH",
        body: JSON.stringify({ appleNotes: { enabled } })
      }).catch(() => null);
      const ceiling = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500));
      return Promise.race([fetchPromise, ceiling]);
    },
    onMutate: async (enabled: boolean) => {
      await queryClient.cancelQueries({ queryKey: ["tunnel"] });
      const previous = queryClient.getQueryData<TunnelSnapshot>(["tunnel"]);
      queryClient.setQueryData<TunnelSnapshot | undefined>(["tunnel"], (old) =>
        old && old.appleNotes
          ? { ...old, appleNotes: { ...old.appleNotes, enabled } }
          : old
      );
      return { previous };
    },
    onSuccess: (_data, enabled) => {
      toast.success(enabled ? "Apple Notes mirror enabled" : "Apple Notes mirror disabled");
    },
    onError: (error: Error, _enabled, context) => {
      toast.error(error.message);
      if (context?.previous) queryClient.setQueryData(["tunnel"], context.previous);
    }
  });

  // Cache-buster ties the QR fetch to the observedAt timestamp so a
  // fresh tunnel URL pulls a fresh SVG.
  const qrSrc = tunnelEnabled && liveUrl && snapshot.data?.observedAt
    ? `/api/runtime/tunnel/qr.svg?v=${encodeURIComponent(snapshot.data.observedAt)}`
    : null;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Cloudflare tunnel</CardTitle>
          <CardDescription>
            Expose this gateway publicly via a Cloudflare quick tunnel. Authorization is by URL secret path — no password.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Row label="Tunnel" description={tunnelDescription}>
            <div className="flex items-center gap-2">
              <StatusPill value={tunnelStatus} />
              <Button
                size="sm"
                variant="outline"
                disabled={toggleTunnel.isPending}
                onClick={() => toggleTunnel.mutate(!tunnelEnabled)}
              >
                {tunnelEnabled ? "Disable" : "Enable"}
              </Button>
            </div>
          </Row>

          {qrSrc ? (
            <div className="flex flex-col items-center gap-2 rounded-md border border-border bg-card/40 p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Scan to open on a phone</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrSrc}
                alt="QR code for the current tunnel URL"
                className="h-44 w-44 rounded-sm bg-white"
              />
              <p className="text-[11px] text-muted-foreground">
                The URL embedded in this QR rotates on every gateway restart.
              </p>
            </div>
          ) : null}

          <Row
            label={
              <span className="inline-flex items-center gap-1.5">
                Apple Notes mirror
                <button
                  type="button"
                  aria-label="What is required to enable this?"
                  onClick={() => setInfoOpen(true)}
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border bg-card text-[10px] font-bold text-muted-foreground hover:border-foreground hover:text-foreground"
                >
                  i
                </button>
              </span>
            }
            description={notesDescription}
          >
            <div className="flex items-center gap-2">
              <StatusPill value={notesStatus} />
              <Button
                size="sm"
                variant="outline"
                disabled={!tunnelEnabled || notesAvailable === false || toggleNotes.isPending}
                onClick={() => toggleNotes.mutate(!notesEnabled)}
              >
                {notesEnabled ? "Disable" : "Enable"}
              </Button>
            </div>
          </Row>

          {snapshot.data?.appleNotes?.lastError && notesEnabled ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {snapshot.data.appleNotes.lastError}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apple Notes mirror — requirements</DialogTitle>
            <DialogDescription>
              The runtime mirrors the current tunnel URL into a Note inside your iCloud account so every signed-in device sees the latest URL without scanning a new QR.
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-2 pl-5 text-xs text-muted-foreground">
            <li>macOS host (Notes.app is not available on Linux or Windows).</li>
            <li>iCloud signed in <em>and</em> visible inside Notes.app — open Notes once if you have never used it on this Mac.</li>
            <li>
              Automation permission granted to the process running gini. macOS prompts on the first sync attempt; if no prompt appears, open <span className="font-mono text-[11px]">System Settings → Privacy &amp; Security → Automation</span> and allow Notes for the gini runtime.
            </li>
            <li>The tunnel itself must be enabled — the mirror toggle stays disabled until you flip it on above.</li>
          </ul>
          <p className="text-xs text-muted-foreground">
            The note lives in a top-level folder named <span className="font-mono text-[11px]">gini</span> by default. The body refreshes on every URL change.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface RowProps {
  label: React.ReactNode;
  description: React.ReactNode;
  children: React.ReactNode;
}

function Row({ label, description, children }: RowProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <div>{children}</div>
    </div>
  );
}
