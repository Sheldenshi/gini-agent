"use client";

import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Toaster } from "sonner";
import { RuntimeStreamBridge } from "./RuntimeStreamBridge";
import { UpdateGateProvider } from "./UpdateGate";

// React 19 warns whenever a component renders a `<script>` tag — the tag is
// non-functional on client re-renders. `next-themes` 0.4.6 (last released
// March 2025, unmaintained) injects a no-FOUC inline `<script>` inside its
// provider, so every page load fires this warning during render. Next.js
// 16.2's browserToTerminal feature forwards it to the dev terminal AND
// surfaces it in the in-page error overlay; the theme functionality is
// fine, the warning is cosmetic noise that scrolls real errors off the
// page. Tracked upstream:
//   https://github.com/pacocoursey/next-themes/issues/387
//   https://github.com/shadcn-ui/ui/issues/10104
//
// Filter via a module-level console.error wrap. Runs before any component
// renders — both during SSR (the server's Node.js console.error captures
// the warning and Next.js's browserToTerminal feature forwards it to the
// browser dev overlay) and during client hydration. A useEffect-installed
// wrap would arrive too late because the warning fires DURING render.
// Re-wrap is idempotent via the `__giniNextThemesFilter` marker — HMR
// re-importing this module detects the prior wrap and short-circuits.
const SCRIPT_TAG_WARNING_FRAGMENT = "Encountered a script tag while rendering React component";
type WrappedConsoleError = typeof console.error & { __giniNextThemesFilter?: true };
if (!(console.error as WrappedConsoleError).__giniNextThemesFilter) {
  const original = console.error;
  const wrapped: WrappedConsoleError = ((...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && first.includes(SCRIPT_TAG_WARNING_FRAGMENT)) return;
    return original.apply(console, args as Parameters<typeof console.error>);
  }) as WrappedConsoleError;
  wrapped.__giniNextThemesFilter = true;
  console.error = wrapped;
}

export function Providers({ children }: { children: ReactNode }) {
  // The /pair page is shown to an UNPAIRED device with no session. The global
  // SSE bridge opens an EventSource to /api/runtime/events/stream, which 401s
  // (and auto-retries) over the relay until the device is paired — pure console
  // noise on the pairing screen. Skip it on /pair; every other route mounts it.
  const pathname = usePathname();
  // Exact /pair (or subpaths) only — a broad prefix would also match a future
  // route like /pairing.
  const onPairPage = pathname === "/pair" || (pathname?.startsWith("/pair/") ?? false);
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      // SSE-driven invalidation (via RuntimeStreamBridge) handles freshness.
      // Window-focus refetch is a safety net for when the browser closes idle
      // EventSource connections on tab background.
      queries: { refetchOnWindowFocus: true, staleTime: 5_000, retry: 1 }
    }
  }));
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
      <QueryClientProvider client={client}>
        {!onPairPage && <RuntimeStreamBridge />}
        {/* The update gate blurs the app while a self-update applies. It needs
            /status, so skip it on the pre-auth /pair screen (same as the
            stream bridge); Toaster stays outside it so error toasts render
            above the blur. */}
        {onPairPage ? children : <UpdateGateProvider>{children}</UpdateGateProvider>}
        <Toaster richColors position="bottom-right" />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
