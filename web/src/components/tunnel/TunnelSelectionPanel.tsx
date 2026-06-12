"use client";

import { useState } from "react";
import { Globe, Plug, Lock, Loader2, Info, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DocReference } from "@/components/DocReference";
import type { TunnelProvider, TunnelProviderId, TunnelState } from "./types";

// Hosted docs URL for the Remote Access guide's native-connects section —
// rendered inline via DocReference, same pattern as connector docsUrl links.
// Complements each row's (i) setup steps with the long-form per-provider
// guide (and the manual-fronts fallback for setups the drivers don't cover).
const REMOTE_ACCESS_DOCS_URL =
  "https://gini.lilaclabs.ai/docs/remote-access#native-connects-tailscale-ngrok-cloudflare";

const PROVIDER_ICON: Record<TunnelProviderId, LucideIcon> = {
  "gini-relay": Globe,
  tailscale: Plug,
  ngrok: Plug,
  cloudflare: Lock
};

/**
 * Provider picker (selection design Variant02). The selected provider's
 * trailing button reflects status: "Connect" when idle/error, a
 * "Connecting..." + destructive Cancel while "connecting" (gini-relay may be
 * waiting on its OAuth consent tab; manual drivers on their agent's URL), and
 * a destructive "Disconnect" when "connected" (so the live tunnel can be torn
 * down from the edit view too). No URL is ever shown here.
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
  // Which provider's setup instructions are expanded (the row's info toggle).
  // One at a time keeps the panel compact; null = all collapsed.
  const [setupFor, setSetupFor] = useState<TunnelProviderId | null>(null);

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
          const setupOpen = setupFor === p.id;
          return (
            <div key={p.id} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
            <div
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
                      Connecting...
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
            {p.setup && p.setup.length > 0 && (
              // Info toggle: how to set this provider up (the reason a
              // disabled row can't connect, and the exact steps to fix it).
              // A SIBLING of the row, not a child — Playwright/AT treat
              // descendants of aria-disabled as non-interactive, and these
              // instructions exist precisely FOR the disabled state.
              <button
                type="button"
                aria-label={`${p.name} setup instructions`}
                aria-expanded={setupOpen}
                onClick={() => setSetupFor(setupOpen ? null : p.id)}
                className={cn(
                  "shrink-0 self-center rounded-full p-1 transition-colors hover:text-foreground",
                  setupOpen ? "text-foreground" : "text-muted-foreground"
                )}
              >
                <Info className="size-3.5" />
              </button>
            )}
            </div>
            {setupOpen && p.setup && (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {p.enabled ? `${p.name} — how this works` : `Set up ${p.name}`}
                </p>
                <ol className="list-decimal space-y-1 pl-4 text-[12px] leading-relaxed text-foreground">
                  {p.setup.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                {!p.enabled && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Done? Close and reopen this panel — availability is re-checked each time it opens.
                  </p>
                )}
              </div>
            )}
            </div>
          );
        })}
      </div>

      <p className="px-4 pb-1 text-[11px] leading-relaxed text-muted-foreground">
        Unavailable providers show an <Info aria-hidden className="inline size-3 align-[-2px]" /> with
        setup steps; the full guide is{" "}
        <DocReference url={REMOTE_ACCESS_DOCS_URL}>
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Remote Access
          </button>
        </DocReference>
        .
      </p>

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
