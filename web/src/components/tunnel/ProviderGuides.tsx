"use client";

import { Globe } from "lucide-react";
import { DocReference } from "@/components/DocReference";
import { TailscaleLogo, NgrokLogo, CloudflareLogo } from "./tunnel-logos";
import { PROVIDER_DOC_URLS } from "./provider-docs";
import type { TunnelProviderId } from "./types";

const GUIDES: Array<{
  id: TunnelProviderId;
  name: string;
  Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
}> = [
  { id: "gini-relay", name: "Gini Relay", Icon: Globe },
  { id: "tailscale", name: "Tailscale", Icon: TailscaleLogo },
  { id: "ngrok", name: "ngrok", Icon: NgrokLogo },
  { id: "cloudflare", name: "Cloudflare", Icon: CloudflareLogo }
];

// Per-provider remote-access guides for the sidebar footer: each entry opens
// ONLY that provider's guide (docs/remote-access/<id>.md) in a slide-over —
// there is no aggregate guide in the app. A compact two-column grid keeps the
// footer to two extra rows.
export function ProviderGuides() {
  return (
    <div className="mt-1.5">
      <p className="px-2 text-[10px] font-medium uppercase tracking-wide text-sidebar-foreground/40">
        Remote access
      </p>
      <div className="mt-0.5 grid grid-cols-2 gap-x-1">
        {GUIDES.map(({ id, name, Icon }) => (
          <DocReference key={id} url={PROVIDER_DOC_URLS[id]}>
            <button
              type="button"
              aria-label={`${name} remote access guide`}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <Icon className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{name}</span>
            </button>
          </DocReference>
        ))}
      </div>
    </div>
  );
}
