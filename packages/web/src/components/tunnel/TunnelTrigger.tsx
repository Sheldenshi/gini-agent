"use client";

import * as React from "react";
import { QrCode, Signal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Top-right tunnel trigger (selection design Variant16). Split layout: an icon
 * tap target plus a compact status body. Shows a connected indicator when the
 * tunnel is live. The whole control is a single Button so the entire surface is
 * the clickable popover anchor; the ref/props forward to it.
 */
export const TunnelTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof Button> & { connected?: boolean; provider?: string | null }
>(function TunnelTrigger({ connected = false, provider = null, className, ...props }, ref) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      aria-label={connected ? "Tunnel connected" : "Open tunnel"}
      className={cn(
        "h-10 w-full justify-start gap-0 overflow-hidden rounded-lg border border-border bg-card p-0 hover:bg-card",
        className
      )}
      {...props}
    >
      <span className="relative flex h-10 w-10 items-center justify-center border-r border-border">
        <QrCode className="h-4 w-4" />
        {connected && (
          <span className="absolute right-1 top-1 flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-card" />
          </span>
        )}
      </span>
      <span className="flex flex-1 flex-col justify-center gap-1 px-2.5 py-1.5 text-left">
        <span className="flex items-center gap-1.5">
          <Signal
            className={cn(
              "h-3.5 w-3.5",
              connected ? "text-emerald-500" : "text-muted-foreground"
            )}
          />
          <span
            className={cn(
              "text-xs font-medium leading-none",
              connected ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {connected ? "Live" : "Off"}
          </span>
        </span>
        <span className="truncate font-mono text-[10px] leading-none text-muted-foreground">
          {connected ? provider ?? "tunnel" : "no tunnel"}
        </span>
      </span>
    </Button>
  );
});
