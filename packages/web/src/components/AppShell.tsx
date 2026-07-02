"use client";

import { usePathname } from "next/navigation";
import { MobileTopBar, Sidebar } from "@/components/Sidebar";

// The /pair page is a pre-auth, standalone surface shown to a device that has
// no session yet. Wrapping it in the authenticated app chrome (Sidebar +
// TunnelMenu) fires /api/runtime/* queries that 401 for the unpaired device
// (console noise) and leaks app navigation onto the pairing screen. So /pair
// renders bare; every other route gets the full shell. See ADR
// device-pairing-auth.md.
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Exact /pair (or its subpaths) only — not a broad prefix, so a future route
  // like /pairing isn't accidentally treated as the bare pairing page.
  if (pathname === "/pair" || pathname?.startsWith("/pair/")) {
    return <>{children}</>;
  }
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <MobileTopBar />
        <main className="relative flex flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
