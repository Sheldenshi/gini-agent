"use client";

import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/lib/use-is-mobile";
import { DocSheet } from "@/components/DocSheet";
import { TunnelTrigger } from "./TunnelTrigger";
import { TunnelSelectionPanel } from "./TunnelSelectionPanel";
import { TunnelConnectedPopover } from "./TunnelConnectedPopover";
import { PROVIDER_DOC_URLS } from "./provider-docs";
import { useTunnel } from "./useTunnel";
import type { TunnelProviderId } from "./types";

/**
 * Anchors the tunnel popover to the trigger and renders the correct view from
 * the state-derivation table:
 *   - status "connected"            -> connected popover (QR + url + disconnect)
 *   - "idle" / "connecting" / error -> selection panel
 * "Edit" from the connected view shows the selection panel without tearing the
 * tunnel down. State + actions come from useTunnel (the live gateway-backed hook).
 */
export function TunnelMenu() {
  const { state, error, select, connect, cancel, disconnect, refresh } = useTunnel();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  // Which provider's setup guide is open. Connect is the single affordance:
  // the gateway re-checks the prerequisite on every attempt (so a freshly
  // installed CLI just works), and a `provider_unavailable` rejection opens
  // that provider's guide (docs/remote-access/<id>.md) instead of leaving
  // only the error banner.
  const [guideFor, setGuideFor] = useState<TunnelProviderId | null>(null);
  const handleConnect = (provider?: TunnelProviderId) => {
    void connect(provider).then((result) => {
      if (!result.ok && result.code === "provider_unavailable" && provider) {
        setGuideFor(provider);
      }
    });
  };
  // The trigger now lives in the sidebar footer. Open the popover to the right
  // (into the content area) on desktop; on mobile the sidebar is a full-width
  // Sheet, so a side placement would push the 24rem popover off-screen — open it
  // upward over the drawer instead.
  const isMobile = useIsMobile();

  const connected = state.status === "connected";
  // Drop the edit override once we're no longer connected so the natural
  // selection panel takes over.
  useEffect(() => {
    if (!connected) setEditing(false);
  }, [connected]);

  // Reset the edit override whenever the popover closes by ANY path (Escape,
  // outside-click, trigger toggle, or dismissSelection's close branch). Keyed on
  // `open` so a close that bypasses Radix's onOpenChange still clears `editing`,
  // and the next open of a connected tunnel lands on the connected (QR) view.
  useEffect(() => {
    if (!open) setEditing(false);
  }, [open]);

  const showConnected = connected && !editing;

  // Dismissing the selection panel (its X / Cancel / Save): if we arrived here
  // via "Edit" from the connected view, return to that connected (QR) view
  // instead of closing the whole popover; otherwise (a standalone selection with
  // no live tunnel to return to) close.
  const dismissSelection = () => {
    if (editing) setEditing(false);
    else setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) refresh();
      }}
    >
      <PopoverTrigger asChild>
        <TunnelTrigger connected={connected} provider={state.selectedProvider} />
      </PopoverTrigger>
      <PopoverContent
        side={isMobile ? "top" : "right"}
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="w-[min(24rem,calc(100vw-2rem))] overflow-hidden p-0"
      >
        {/* Surface a request failure (connect/select/disconnect) so it isn't
            silently swallowed; state.message carries gateway-reported errors,
            this carries client-side fetch failures. */}
        {error && (
          <p role="alert" className="border-b border-border px-4 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {/* One stable container so the connecting->connected view swap animates
            height/opacity instead of an abrupt resize. Honors reduced motion.
            grid-cols-1 pins the swap track to the popover width so neither view
            can size the shared cell to max-content and overflow the 384px box. */}
        <div className="grid w-96 grid-cols-1 transition-all duration-200 ease-out motion-reduce:transition-none">
          <div
            key={showConnected ? "connected" : "selection"}
            className="col-start-1 row-start-1 min-w-0 duration-150 data-open:animate-in data-open:fade-in-0 motion-reduce:animate-none"
            data-open
          >
            {showConnected ? (
              <TunnelConnectedPopover
                state={state}
                onEdit={() => setEditing(true)}
                onDisconnect={disconnect}
              />
            ) : (
              <TunnelSelectionPanel
                state={state}
                onSelect={select}
                onConnect={handleConnect}
                onCancel={cancel}
                onDisconnect={disconnect}
                onClose={dismissSelection}
              />
            )}
          </div>
        </div>
        {guideFor && (
          <DocSheet
            key={guideFor}
            url={PROVIDER_DOC_URLS[guideFor]}
            open
            onOpenChange={(next) => {
              if (!next) setGuideFor(null);
            }}
            lead={
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-foreground">
                This provider isn&apos;t ready on this machine yet
                {state.providers.find((p) => p.id === guideFor)?.requires
                  ? ` — it requires ${state.providers.find((p) => p.id === guideFor)?.requires}`
                  : ""}
                . Follow the guide below, then tap Connect again — availability is re-checked on
                every attempt.
              </p>
            }
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
