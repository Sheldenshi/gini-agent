"use client";

import { useState } from "react";
import { Smartphone } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TunnelQR } from "@/components/tunnel/TunnelQR";
import { useTunnel } from "@/components/tunnel/useTunnel";
import { PairRequestsPanel } from "./PairRequestsPanel";

/**
 * Operator-facing entry point for adding a device. The dialog shows a QR for the
 * live tunnel URL (the device scans it to land on /pair) alongside the live
 * approval panel, so the operator can scan and approve from one surface.
 *
 * The body (tunnel state via useTunnel + the polling PairRequestsPanel) is
 * mounted ONLY while the dialog is open. Otherwise the trigger — which sits on
 * the settings page and the tunnel popover — would fire a tunnel fetch and open
 * the pairing poll on every render even when the operator never opens it.
 */
export function PairDeviceDialog({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" className={className}>
          <Smartphone className="h-4 w-4" />
          Pair a device
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
          <DialogDescription>Scan to add a phone or another browser</DialogDescription>
        </DialogHeader>
        {open ? <PairDeviceBody /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PairDeviceBody() {
  const { state } = useTunnel();
  const url = state.url ?? "";
  return (
    <>
      {url ? (
        <div className="grid place-items-center py-2">
          <TunnelQR value={url} className="h-44 w-44" />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Connect the relay tunnel first, then scan to pair a device.
        </p>
      )}
      <Separator />
      <PairRequestsPanel />
    </>
  );
}
