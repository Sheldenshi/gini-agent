"use client";

import { useState } from "react";
import { Globe, Loader2, X, AlertTriangle } from "lucide-react";
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

// A reconnect keeps the SAME public host — so paired devices survive it —
// only where the provider re-publishes a stable address: gini-relay keys its
// subdomain to a stable deviceId, and tailscale to the machine name. ngrok and
// cloudflare (quick tunnels) mint a fresh host every connect. So switching the
// LIVE provider to a different one always changes the host (a paired device's
// session cookie is host-bound and is invalidated), EXCEPT relay→relay /
// tailscale→tailscale, which can't happen here (you can't switch to the
// provider that's already live). Net: any switch away from a live provider
// changes the host. We surface that before tearing the working tunnel down.
function switchChangesHost(from: TunnelProviderId, to: TunnelProviderId): boolean {
  return from !== to;
}

/**
 * Provider picker — Option 1, "one active, tap to switch". A single tunnel is
 * live at a time (the gateway is single-tunnel: connecting a provider tears
 * down whatever was live and makes the new one the selection). So there is no
 * separate "select" step and no Save/Cancel: the live tunnel IS the selection.
 *
 * Each row carries ONE action:
 *   - the LIVE provider           → destructive Disconnect
 *   - the provider mid-connect     → "Connecting…" + destructive Cancel
 *   - any other available provider → Connect (relabeled "Switch" when a tunnel
 *                                    is already live, since it replaces it)
 *
 * Connect/Switch stays live even on a "Requires …" row: the gateway re-checks
 * the prerequisite server-side (a freshly-installed CLI just works), and a
 * genuine miss rejects with `provider_unavailable`, on which the owner
 * (TunnelMenu) opens that provider's setup guide. A LIVE provider is proof it's
 * available, so the connected row ignores the (lag-prone) detection flag — no
 * "Requires …", always Disconnect.
 *
 * Switching away from a live provider changes the public host, which drops
 * every device paired on the old one (their host-bound session is invalidated)
 * — so a switch first asks for confirmation via an in-panel screen.
 */
export function TunnelSelectionPanel({
  state,
  onConnect,
  onCancel,
  onDisconnect,
  onClose,
  className
}: {
  state: TunnelState;
  onConnect: (provider?: TunnelProviderId) => void;
  onCancel: () => void;
  onDisconnect: () => void;
  onClose: () => void;
  className?: string;
}) {
  const connecting = state.status === "connecting";
  const connected = state.status === "connected";
  const liveProvider = connected ? state.selectedProvider : null;
  // A switch that needs confirmation, staged until the user confirms/cancels.
  const [pendingSwitch, setPendingSwitch] = useState<TunnelProvider | null>(null);

  // Connect/Switch entry point. A switch away from a live provider drops the
  // old host's paired devices, so stage a confirm first; a fresh connect (no
  // live tunnel) goes straight through.
  const requestConnect = (p: TunnelProvider): void => {
    if (liveProvider && liveProvider !== p.id && switchChangesHost(liveProvider, p.id)) {
      setPendingSwitch(p);
      return;
    }
    onConnect(p.id);
  };

  const fromName = state.providers.find((p) => p.id === liveProvider)?.name ?? liveProvider;

  return (
    <div className={cn("relative w-full text-card-foreground", className)}>
      {/* The switch confirm is an absolute overlay, not a separate view — the
          panel stays mounted at full height underneath, so the popover box
          never resizes when the confirm appears (no jarring height jump). */}
      {pendingSwitch && (
        <div className="absolute inset-0 z-10 flex flex-col bg-popover">
          <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <span className="text-sm font-semibold leading-none">Switch tunnel?</span>
            <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => setPendingSwitch(null)}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="flex flex-1 flex-col gap-3 p-4">
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <p className="text-sm leading-relaxed text-muted-foreground">
                Switching to <span className="font-medium text-foreground">{pendingSwitch.name}</span> gives
                your agent a new public address. Devices paired over{" "}
                <span className="font-medium text-foreground">{fromName}</span> will need to scan the new QR
                code to reconnect.
              </p>
            </div>
            <div className="mt-auto flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPendingSwitch(null)}>
                Keep {fromName}
              </Button>
              <Button
                size="sm"
                aria-label={`Switch to ${pendingSwitch.name}`}
                onClick={() => {
                  const target = pendingSwitch;
                  setPendingSwitch(null);
                  onConnect(target.id);
                }}
              >
                Switch to {pendingSwitch.name}
              </Button>
            </div>
          </div>
        </div>
      )}
      <div
        className="flex w-full flex-col"
        aria-label="Tunnel provider"
        aria-busy={connecting}
        aria-hidden={pendingSwitch ? true : undefined}
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
          const isLive = connected && p.id === liveProvider;
          const rowConnecting = connecting && p.id === state.selectedProvider;
          // A live tunnel is proof the provider is AVAILABLE — the detection
          // probe is a best-effort hint that can lag/flake, so it must never
          // override a real connection. Otherwise availability gates the action.
          const available = p.enabled || isLive;
          return (
            <div
              key={p.id}
              className={cn(
                "flex min-h-15 w-full items-center gap-2 rounded-lg border px-3 py-2.5 transition-colors",
                // Green is reserved for the LIVE connection; every other row is
                // neutral. There's no "selected but not connected" state anymore.
                isLive ? "border-emerald-500/60 bg-emerald-500/5" : "border-border"
              )}
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-md border",
                    isLive ? "border-emerald-500/50 text-emerald-500" : "border-border text-muted-foreground"
                  )}
                >
                  <Icon className="size-4" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{p.name}</span>
                    {isLive && (
                      <span className="shrink-0 text-xs font-medium text-emerald-500">Connected</span>
                    )}
                  </div>
                  {!available && p.requires && (
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
                ) : isLive ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    aria-label={`Disconnect ${p.name}`}
                    onClick={onDisconnect}
                  >
                    Disconnect
                  </Button>
                ) : (
                  // ONE call-to-action per row. "Connect" when nothing is live,
                  // "Switch" when it replaces a live tunnel (the gateway tears
                  // the old one down). Always tappable — even a "Requires …" row
                  // routes through, so the gateway can re-check or open the guide.
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`${liveProvider ? "Switch to" : "Connect"} ${p.name}`}
                    disabled={connecting}
                    onClick={() => requestConnect(p)}
                  >
                    {liveProvider ? "Switch" : "Connect"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

        {state.status === "error" && state.message && (
          <div className="px-4 pb-3">
            <p className="text-xs text-destructive">{state.message}</p>
          </div>
        )}
      </div>
    </div>
  );
}
