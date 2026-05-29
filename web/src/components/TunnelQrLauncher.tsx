"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOff, Loader2, Power, QrCode, RotateCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { api } from "@/lib/api";

interface TunnelSnapshot {
  enabled: boolean;
  secret: string | null;
  publicUrl: string | null;
  secretRevision: string | null;
  lastError: string | null;
  appleNotes: {
    enabled: boolean;
    notesAvailable: boolean | null;
    lastError: string | null;
  };
}

type ConfirmKind = "disable" | "rotate" | null;

async function fetchTunnel(): Promise<TunnelSnapshot> {
  const res = await fetch("/api/runtime/tunnel", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Tunnel snapshot fetch failed (${res.status})`);
  return (await res.json()) as TunnelSnapshot;
}

export function TunnelQrLauncher() {
  const pathname = usePathname();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // QR + URL default to HIDDEN inside the modal; the operator clicks the eye
  // overlay to reveal once they're actually about to scan. Re-hidden every
  // time the modal closes so the next open starts safe again.
  const [qrRevealed, setQrRevealed] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmKind>(null);
  useEffect(() => {
    if (!open) {
      setQrRevealed(false);
      setConfirm(null);
    }
  }, [open]);
  const isSetup = pathname.startsWith("/setup");

  const { data } = useQuery({
    queryKey: ["tunnel-launcher"],
    queryFn: fetchTunnel,
    refetchInterval: 5_000,
    // Failures don't matter for the launcher; just hide it.
    retry: 1,
    enabled: !isSetup
  });

  // Invalidating both query keys keeps the settings card (`["tunnel"]`) and
  // the launcher in lock-step so a toggle from one surface reflects on the
  // other within the SSE-driven refetch window.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tunnel"] });
    qc.invalidateQueries({ queryKey: ["tunnel-launcher"] });
  };

  const enable = useMutation({
    mutationFn: () => api<TunnelSnapshot>("/tunnel", { method: "PATCH", body: JSON.stringify({ enabled: true }) }),
    onSuccess: () => { toast.success("Tunnel enabled"); invalidate(); },
    onError: (err: Error) => toast.error(err.message)
  });

  const disable = useMutation({
    mutationFn: () => api<TunnelSnapshot>("/tunnel", { method: "PATCH", body: JSON.stringify({ enabled: false }) }),
    onSuccess: () => { toast.success("Tunnel disabled"); invalidate(); setConfirm(null); },
    onError: (err: Error) => { toast.error(err.message); setConfirm(null); }
  });

  const rotate = useMutation({
    mutationFn: () => api<TunnelSnapshot>("/tunnel", { method: "PATCH", body: JSON.stringify({ rotateSecret: true }) }),
    onSuccess: () => { toast.success("Secret rotated"); invalidate(); setConfirm(null); },
    onError: (err: Error) => { toast.error(err.message); setConfirm(null); }
  });

  const busy = enable.isPending || disable.isPending || rotate.isPending;

  // Hide on /setup/* (see docs/adr/tunnel-and-mobile-access.md
  // "Decision"). Otherwise render the icon
  // unconditionally — when the tunnel is off the modal shows an Enable
  // affordance, when starting it shows a spinner, when ready it shows
  // the QR + Disable / Rotate row. The settings card still owns the full
  // surface (Apple Notes toggle, refresh-notes, last-error), but the
  // launcher gives one-tap reach for the common ops.
  if (isSetup) return null;
  if (!data) return null;

  const isReady = data.enabled && Boolean(data.publicUrl) && Boolean(data.secret);
  const isStarting = data.enabled && (!data.publicUrl || !data.secret);

  return (
    <>
      <Button
        size="icon"
        variant="outline"
        aria-label="Open tunnel controls"
        className="fixed right-4 top-4 z-50 h-10 w-10 rounded-full shadow-md"
        onClick={() => setOpen(true)}
        data-testid="tunnel-qr-launcher"
      >
        <QrCode className="h-5 w-5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          {isReady ? (
            <>
              <DialogHeader>
                <DialogTitle>Scan with your phone</DialogTitle>
                <DialogDescription>
                  Open the camera on your phone and point it at the QR code. The link contains a{" "}
                  <strong className="font-semibold text-foreground">one-time secret</strong> — anyone who
                  scans it (or photographs your screen) gets the same access you have.{" "}
                  <strong className="font-semibold text-foreground">Keep it private</strong>; rotate from
                  the row below if you suspect a leak.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col items-center gap-3">
                <button
                  type="button"
                  onClick={() => setQrRevealed((r) => !r)}
                  aria-label={qrRevealed ? "Hide tunnel QR" : "Reveal tunnel QR"}
                  className="group relative h-64 w-64 select-none overflow-hidden rounded border bg-white p-2"
                  data-testid="tunnel-qr-reveal-toggle"
                >
                  <img
                    src={`/api/runtime/tunnel/qr.svg?v=${encodeURIComponent(data.secretRevision ?? "")}`}
                    alt="Tunnel QR"
                    draggable={false}
                    onDragStart={(e) => e.preventDefault()}
                    onContextMenu={(e) => e.preventDefault()}
                    className={`h-full w-full select-none transition duration-200 ${qrRevealed ? "blur-0" : "blur-md"}`}
                    data-testid="tunnel-qr-image"
                  />
                  {!qrRevealed ? (
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/60 text-foreground backdrop-blur-sm transition group-hover:bg-background/70">
                      <EyeOff className="h-8 w-8" />
                      <span className="text-sm font-semibold">Click to reveal</span>
                      <span className="px-3 text-center text-[10px] uppercase tracking-wider text-muted-foreground">
                        Contains a live secret
                      </span>
                    </div>
                  ) : null}
                </button>
                {/* The text mirror of the bootstrap URL — also hidden until the
                    operator reveals. The launcher is loopback-only-by-design
                    in the disabled gate, but we surface the same controls on
                    the tunneled view too (per the broadened policy in
                    tunnel-policy.ts); the gate is about shoulder-surfing, not
                    cross-process authorization. */}
                <p className="break-all rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                  {qrRevealed && data.publicUrl && data.secret
                    ? `${data.publicUrl.replace(/\/+$/, "")}/${data.secret}`
                    : "•••••••••••••••••••••••••••••••••••"}
                </p>
              </div>
              <DialogFooter className="!flex-row items-center justify-between gap-2 sm:justify-between">
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirm("rotate")}
                    disabled={busy}
                    data-testid="tunnel-launcher-rotate"
                    title="Rotate the secret. Invalidates the current QR + every outstanding session."
                  >
                    <RotateCw className="mr-2 h-4 w-4" />
                    Rotate
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirm("disable")}
                    disabled={busy}
                    data-testid="tunnel-launcher-disable"
                    title="Disable the tunnel. The QR + URL stop working immediately."
                  >
                    <Power className="mr-2 h-4 w-4" />
                    Disable
                  </Button>
                </div>
                <DialogClose asChild>
                  <Button variant="secondary" size="sm">Close</Button>
                </DialogClose>
              </DialogFooter>
            </>
          ) : isStarting ? (
            <>
              <DialogHeader>
                <DialogTitle>Bringing tunnel up…</DialogTitle>
                <DialogDescription>
                  Spawning <code className="font-mono text-xs">cloudflared</code> and waiting for the
                  rotating <code className="font-mono text-xs">trycloudflare.com</code> hostname to
                  come online. Usually takes a few seconds.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary" size="sm">Close</Button>
                </DialogClose>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Tunnel is off</DialogTitle>
                <DialogDescription>
                  The Cloudflare quick tunnel is disabled. Enable it to get a one-time URL + QR you
                  can scan from your phone to use Gini off-LAN.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col items-center gap-3 py-4">
                <ShieldAlert className="h-12 w-12 text-muted-foreground" />
                <p className="px-3 text-center text-xs text-muted-foreground">
                  Anyone with the URL (or a photo of the QR) can act as you until the secret is
                  rotated or the tunnel is disabled. Keep it to yourself.
                </p>
                {data.lastError ? (
                  <p className="break-all rounded bg-destructive/10 px-2 py-1 text-center font-mono text-[10px] text-destructive">
                    Last error: {data.lastError}
                  </p>
                ) : null}
              </div>
              <DialogFooter className="!flex-row items-center justify-between gap-2 sm:justify-between">
                <DialogClose asChild>
                  <Button variant="secondary" size="sm">Close</Button>
                </DialogClose>
                <Button
                  onClick={() => enable.mutate()}
                  disabled={enable.isPending}
                  data-testid="tunnel-launcher-enable"
                  size="sm"
                >
                  {enable.isPending
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <Power className="mr-2 h-4 w-4" />}
                  Enable tunnel
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {/* Confirm dialog stacked above. Mirrors the TunnelCard's confirm-on-
          destructive pattern so the operator can't lose the live tunnel
          with a single misclick on the floating icon. */}
      <Dialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent className="max-w-sm">
          {confirm === "disable" ? (
            <>
              <DialogHeader>
                <DialogTitle>Disable the tunnel?</DialogTitle>
                <DialogDescription>
                  The public URL stops working immediately. Anyone currently using the cloudflare
                  link loses access — including this browser, if you're on the cloudflare host.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" size="sm" onClick={() => setConfirm(null)} disabled={disable.isPending}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => disable.mutate()}
                  disabled={disable.isPending}
                  data-testid="tunnel-launcher-disable-confirm"
                >
                  {disable.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Disable
                </Button>
              </DialogFooter>
            </>
          ) : confirm === "rotate" ? (
            <>
              <DialogHeader>
                <DialogTitle>Rotate the secret?</DialogTitle>
                <DialogDescription>
                  Mints a fresh 192-bit secret. Every outstanding session invalidates immediately —
                  including this browser if you're on the cloudflare host. You'll need to re-scan
                  the new QR (or revisit the new bootstrap URL) to get back in.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" size="sm" onClick={() => setConfirm(null)} disabled={rotate.isPending}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => rotate.mutate()}
                  disabled={rotate.isPending}
                  data-testid="tunnel-launcher-rotate-confirm"
                >
                  {rotate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Rotate
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
