"use client";

import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TunnelTrigger } from "./TunnelTrigger";
import { TunnelSelectionPanel } from "./TunnelSelectionPanel";
import { TunnelConnectedPopover } from "./TunnelConnectedPopover";
import { useTunnel } from "./useTunnel";

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
        <TunnelTrigger connected={connected} />
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={8}
        className="w-96 overflow-hidden p-0"
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
                onConnect={connect}
                onCancel={cancel}
                onDisconnect={disconnect}
                onClose={dismissSelection}
              />
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
