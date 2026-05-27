"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

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

async function fetchTunnel(): Promise<TunnelSnapshot> {
  const res = await fetch("/api/runtime/tunnel", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Tunnel snapshot fetch failed (${res.status})`);
  return (await res.json()) as TunnelSnapshot;
}

export function TunnelQrLauncher() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isSetup = pathname.startsWith("/setup");

  const { data } = useQuery({
    queryKey: ["tunnel-launcher"],
    queryFn: fetchTunnel,
    refetchInterval: 5_000,
    // Failures don't matter for the launcher; just hide it.
    retry: 1,
    enabled: !isSetup
  });

  // Hide on /setup/* per PLAN.md "Goals". Hide when tunnel disabled or when
  // the snapshot is the redacted shape (publicUrl null → we're tunneled, so
  // QR endpoints would 404 anyway and we shouldn't surface them).
  if (isSetup) return null;
  if (!data?.enabled) return null;
  if (!data.publicUrl) return null;

  return (
    <>
      <Button
        size="icon"
        variant="outline"
        aria-label="Open mobile QR"
        className="fixed right-4 top-4 z-50 h-10 w-10 rounded-full shadow-md"
        onClick={() => setOpen(true)}
        data-testid="tunnel-qr-launcher"
      >
        <QrCode className="h-5 w-5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Scan with your phone</DialogTitle>
            <DialogDescription>
              Open the camera on your phone and point it at the QR code. The link contains a one-time
              secret — keep it private.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3">
            <img
              src={`/api/runtime/tunnel/qr.svg?v=${encodeURIComponent(data.secretRevision ?? "")}`}
              alt="Tunnel QR"
              className="h-64 w-64 rounded border bg-white p-2"
              data-testid="tunnel-qr-image"
            />
            <p className="break-all rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
              {data.publicUrl}
            </p>
          </div>
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        </DialogContent>
      </Dialog>
    </>
  );
}
