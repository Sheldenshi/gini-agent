import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SystemNoteBlock } from "@runtime/types";

// Muted italic line used for terminal flags ("Cancelled", "Failed: …") and
// other operator-attributed notes. Kept low-key so it doesn't pull focus
// from the assistant's reply.
//
// Provider-credential failures (block.authError) are the exception: they
// render as an alert card naming the provider, with a CTA whose destination
// depends on how the provider authenticates (issue #205). OAuth/CLI providers
// (codex) link to the hosted re-auth step-through; API-key providers link to
// the Settings → Providers key form, with the provider's own error shown as
// the specific cause.
export function BlockSystemNote({ block }: { block: SystemNoteBlock }) {
  if (block.authError) {
    const { providerLabel, detail, reauthKind, reauthUrl } = block.authError;
    // Fall back to the Settings form for blocks that predate the routing fields
    // (or any with them missing) so an older persisted note never renders a
    // broken CTA.
    const kind = reauthKind ?? "settings";
    const url = reauthUrl ?? "/settings";
    const ctaLabel =
      kind === "docs" ? `Re-authenticate ${providerLabel}` : `Update ${providerLabel} key`;
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-500" aria-hidden />
          <span className="text-xs font-medium text-foreground">{block.text}</span>
        </div>
        {detail ? (
          <p className="mt-1 text-[11px] italic text-muted-foreground">{detail}</p>
        ) : null}
        <Button asChild size="sm" variant="outline" className="mt-2">
          {kind === "docs" ? (
            <a href={url} target="_blank" rel="noreferrer">
              {ctaLabel}
            </a>
          ) : (
            <Link href={url}>{ctaLabel}</Link>
          )}
        </Button>
      </div>
    );
  }
  return (
    <p className="text-xs italic text-muted-foreground">{block.text}</p>
  );
}
