"use client";

import { Globe, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TailscaleLogo, NgrokLogo, CloudflareLogo } from "./tunnel-logos";
import type { TunnelProvider, TunnelProviderId, TunnelState } from "./types";

// Official brand marks for the real providers (see ./tunnel-logos.tsx);
// the managed relay keeps the generic globe — it's Gini's own transport, not
// an external brand.
const PROVIDER_ICON: Record<TunnelProviderId, React.ComponentType<{ className?: string }>> = {
  "gini-relay": Globe,
  tailscale: TailscaleLogo,
  ngrok: NgrokLogo,
  cloudflare: CloudflareLogo
};

/**
 * Provider picker (selection design Variant02). Every row carries ONE
 * call-to-action: Connect. Tapping it attempts the connect — the gateway
 * re-checks the provider's prerequisite server-side, so a freshly-installed
 * CLI just works — and when the provider genuinely isn't ready, the owner
 * (TunnelMenu) opens that provider's setup guide in a slide-over instead.
 * That's why a "Requires …" row still has a live Connect button.
 *
 * The selected provider's action reflects status: "Connecting..." + a
 * destructive Cancel while pending, a destructive Disconnect when connected.
 * Radio semantics live on the icon+label area of each row so the action
 * cluster stays interactive even when the radio is aria-disabled (an
 * unavailable provider can't be SELECTED — the gateway rejects it — but its
 * Connect must stay tappable to reach the guide). While connecting the panel
 * locks down — other rows and Save are gated and the panel is aria-busy.
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
          // An unavailable provider can't be SELECTED (the gateway rejects
          // it), and while connecting every other row is locked.
          const radioDisabled = !p.enabled || (connecting && !isSelected);
          return (
            <div
              key={p.id}
              className={cn(
                "flex min-h-15 w-full items-center gap-2 rounded-lg border px-3 py-2.5 transition-colors",
                // Green is reserved for a LIVE connection. A selected-but-not-yet-
                // connected provider gets a neutral highlight, so it reads as
                // "chosen, still needs Connect" rather than "connected/good".
                isSelected
                  ? connected
                    ? "border-emerald-500/60 bg-emerald-500/5"
                    : "border-foreground/30 bg-foreground/5"
                  : "border-border",
                !radioDisabled && "hover:border-foreground/30"
              )}
            >
              <div
                role="radio"
                aria-checked={isSelected}
                aria-disabled={radioDisabled || undefined}
                tabIndex={radioDisabled ? -1 : 0}
                onClick={() => {
                  if (!radioDisabled) onSelect(p.id);
                }}
                onKeyDown={(e) => {
                  if (radioDisabled) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(p.id);
                  }
                }}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-3 rounded-md outline-none transition-opacity focus-visible:ring-3 focus-visible:ring-ring/50",
                  radioDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
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
                    <span className="text-[11px] text-muted-foreground">
                      Requires {p.requires} — Connect shows how
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {rowConnecting ? (
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 font-mono text-xs text-amber-500">
                      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                      Connecting...
                    </span>
                    <Button
                      variant="destructive"
                      size="sm"
                      aria-label={`Cancel ${p.name} connect`}
                      onClick={onCancel}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : connected && isSelected ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    aria-label={`Disconnect ${p.name}`}
                    onClick={onDisconnect}
                  >
                    Disconnect
                  </Button>
                ) : (
                  // ONE call-to-action per row, always live (except while
                  // another row is mid-connect): the gateway decides whether
                  // this connects or needs setup first — in which case the
                  // owner opens this provider's guide.
                  <Button
                    size="sm"
                    variant={isSelected ? "default" : "outline"}
                    aria-label={`Connect ${p.name}`}
                    disabled={connecting}
                    onClick={() => onConnect(p.id)}
                  >
                    Connect
                  </Button>
                )}
              </div>
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
