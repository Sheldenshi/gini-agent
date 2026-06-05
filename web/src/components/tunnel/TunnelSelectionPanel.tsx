"use client";

import { Globe, Plug, Lock, Loader2, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { TunnelProvider, TunnelProviderId, TunnelState } from "./types";

const PROVIDER_ICON: Record<TunnelProviderId, LucideIcon> = {
  "gini-relay": Globe,
  tailscale: Plug,
  ngrok: Plug,
  cloudflare: Lock
};

/**
 * Provider picker (selection design Variant02). The selected provider's
 * trailing button reflects status: "Connect" when idle/error, a "Pending
 * Login..." + destructive Cancel while "connecting", and a destructive
 * "Disconnect" when "connected" (so the live tunnel can be torn down from the
 * edit view too). No URL is ever shown here.
 *
 * Rows are real radios (role="radio" + aria-checked) so keyboard users can
 * select with Enter/Space; disabled rows are aria-disabled and removed from the
 * tab order. While connecting the panel locks down — other rows and Save are
 * gated and the panel is marked aria-busy.
 */
export function TunnelSelectionPanel({
  state,
  onSelect,
  onConnect,
  onCancel,
  onDisconnect,
  onClose,
  className
}: {
  state: TunnelState;
  onSelect: (provider: TunnelProviderId) => void;
  onConnect: (provider?: TunnelProviderId) => void;
  onCancel: () => void;
  onDisconnect: () => void;
  onClose: () => void;
  className?: string;
}) {
  const connecting = state.status === "connecting";
  const connected = state.status === "connected";

  return (
    <div
      className={cn("flex w-full flex-col text-card-foreground", className)}
      role="radiogroup"
      aria-label="Tunnel provider"
      aria-busy={connecting}
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold leading-none">Tunnel provider</span>
          <span className="text-xs text-muted-foreground">Choose how Gini is exposed</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-2.5 p-4">
        {state.providers.map((p: TunnelProvider) => {
          const Icon = PROVIDER_ICON[p.id];
          const isSelected = p.id === state.selectedProvider;
          const rowConnecting = connecting && isSelected;
          // While connecting, lock every row except the one mid-connect.
          const rowDisabled = !p.enabled || (connecting && !isSelected);
          return (
            <div
              key={p.id}
              role="radio"
              aria-checked={isSelected}
              aria-disabled={rowDisabled || undefined}
              tabIndex={rowDisabled ? -1 : 0}
              onClick={() => {
                if (!rowDisabled) onSelect(p.id);
              }}
              onKeyDown={(e) => {
                if (rowDisabled) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(p.id);
                }
              }}
              className={cn(
                "flex min-h-15 items-center gap-3 rounded-lg border px-3 py-2.5 outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                // Green is reserved for a LIVE connection. A selected-but-not-yet-
                // connected provider gets a neutral highlight, so it reads as
                // "chosen, still needs Connect" rather than "connected/good".
                isSelected
                  ? connected
                    ? "border-emerald-500/60 bg-emerald-500/5"
                    : "border-foreground/30 bg-foreground/5"
                  : "border-border",
                rowDisabled
                  ? "cursor-not-allowed opacity-50"
                  : "cursor-pointer hover:border-foreground/30"
              )}
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-md border",
                  isSelected
                    ? connected
                      ? "border-emerald-500/50 text-emerald-500"
                      : "border-foreground/40 text-foreground"
                    : "border-border text-muted-foreground"
                )}
              >
                <Icon className="size-4" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  {isSelected && (
                    <span
                      className={cn(
                        "shrink-0 text-xs font-medium",
                        connected ? "text-emerald-500" : "text-muted-foreground"
                      )}
                    >
                      {connected ? "Connected" : "Selected"}
                    </span>
                  )}
                </div>
                {!p.enabled && p.requires && (
                  <span className="text-[11px] text-muted-foreground">Requires {p.requires}</span>
                )}
              </div>
              {isSelected ? (
                rowConnecting ? (
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 font-mono text-xs text-amber-500">
                      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                      Pending Login...
                    </span>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancel();
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : connected ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDisconnect();
                    }}
                  >
                    Disconnect
                  </Button>
                ) : (
                  // Selected but not connected: a filled (primary) Connect so the
                  // call-to-action is unmistakable — the row itself is neutral now.
                  <Button
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onConnect(p.id);
                    }}
                  >
                    Connect
                  </Button>
                )
              ) : (
                <Button size="sm" variant="outline" disabled>
                  Connect
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {state.status === "error" && state.message && (
        <div className="px-4 pb-2">
          <p className="text-xs text-destructive">{state.message}</p>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" onClick={onClose} disabled={connecting}>
          Save
        </Button>
      </div>
    </div>
  );
}
