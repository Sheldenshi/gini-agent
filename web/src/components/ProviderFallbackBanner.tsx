"use client";

import { AlertTriangle } from "lucide-react";
import { useStatus } from "@/lib/queries";
import { providerBrandLabel } from "@/lib/providers";

/**
 * Tab-wide "using a fallback provider" pill, driven by /status. When the
 * selected provider is unconfigured but another configured provider is serving
 * turns (see resolveDispatchProvider), the app stays usable instead of bouncing
 * to /setup — this banner tells the operator to finish wiring their pick.
 * Renders nothing when no fallback is in effect. Mounted beside ConnectionBanner
 * and skipped on /pair, exactly like its siblings.
 */
export function ProviderFallbackBanner() {
  const { data: status } = useStatus();
  const fallback = status?.providerFallback;
  if (!fallback) return null;
  const selected = providerBrandLabel(fallback.selected);
  const using = providerBrandLabel(fallback.using);
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-900 shadow-md dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      <AlertTriangle className="size-4" aria-hidden />
      {selected} isn’t configured — using {using}. Finish setup in Settings.
    </div>
  );
}
