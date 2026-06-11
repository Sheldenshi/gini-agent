"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useRuntimeStreamConnected } from "@/lib/useRuntimeStream";

// How long the stream must stay down before the banner shows. The browser's
// SSE retry plus the resilient reopen recover most blips inside a second or
// two — surfacing those would just flicker. A real gateway restart (drain +
// respawn) comfortably exceeds this.
const SHOW_AFTER_MS = 1500;

/**
 * Tab-wide "reconnecting" pill, driven by the shared runtime event stream's
 * connection state. A gateway restart is routine (auto-update, watchdog
 * kickstart) — the UI treats it as a transient reconnect, not an error
 * cascade. Renders nothing while connected.
 */
export function ConnectionBanner({ showAfterMs = SHOW_AFTER_MS }: { showAfterMs?: number } = {}) {
  const connected = useRuntimeStreamConnected();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (connected) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), showAfterMs);
    return () => clearTimeout(timer);
  }, [connected, showAfterMs]);

  if (!show) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-900 shadow-md dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      Reconnecting to Gini…
    </div>
  );
}
