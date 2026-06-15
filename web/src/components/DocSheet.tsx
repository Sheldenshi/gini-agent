"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { api } from "@/lib/api";
import { parseDocsUrl, type DocSection } from "@/lib/docs";

interface FetchState {
  loading: boolean;
  error?: string;
  data?: DocSection;
}

/**
 * Controlled slide-over that renders an app-referenced doc inline. `url` is
 * the full hosted docs URL the runtime emits; the relative gateway path
 * (+ anchor) is derived from it, and the original url stays the
 * "Open full docs ↗" escape hatch. The doc is fetched once on first open.
 *
 * `lead` renders above the doc body — callers use it for dynamic context the
 * doc can't know (e.g. the tunnel panel's "requires …" availability status).
 * DocReference wraps this with a click-to-open trigger; flows that decide to
 * open a doc programmatically (e.g. Connect on an unavailable provider)
 * drive `open`/`onOpenChange` directly.
 */
export function DocSheet({
  url,
  open,
  onOpenChange,
  lead
}: {
  url: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead?: React.ReactNode;
}) {
  // The fetched doc is cached per url. A caller that swaps `url` in place
  // (no key remount — e.g. AddConnectorDialog switching provider templates)
  // must never see the previous url's doc, so a url change drops the cache
  // during render and re-arms the open-edge fetch below.
  const ref = parseDocsUrl(url);
  const [state, setState] = useState<FetchState>({ loading: false });
  const openedRef = useRef(false);
  // urlRef tracks the CURRENT url so an in-flight fetch can tell when the
  // caller swapped url mid-request: its result must be discarded, or a slow
  // old fetch resolving after the new one would pin the WRONG doc under the
  // new url (sticky, because the data guard in load() never refetches).
  const urlRef = useRef(url);
  urlRef.current = url;
  const [fetchedFor, setFetchedFor] = useState(url);
  if (fetchedFor !== url) {
    setFetchedFor(url);
    setState({ loading: false });
    openedRef.current = false;
  }

  async function load() {
    if (state.data || state.loading) return;
    const requested = url;
    setState({ loading: true });
    try {
      const query = ref!.anchor ? `?section=${encodeURIComponent(ref!.anchor)}` : "";
      const data = await api<DocSection>(`/docs/${ref!.path}${query}`);
      if (urlRef.current !== requested) return; // url swapped mid-fetch — stale
      setState({ loading: false, data });
    } catch (error) {
      if (urlRef.current !== requested) return; // stale rejection — same rule
      setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Fetch on the open EDGE (not via Radix's onOpenChange, which only fires on
  // user interaction — programmatic opens would never load). Once loaded, the
  // data guard makes later edges no-ops; after an error, the next open retries.
  // `fetchedFor` re-fires the effect when a caller swaps `url` in place: the
  // render-time reset above re-armed the edge, so an already-open sheet
  // fetches the new doc immediately.
  useEffect(() => {
    if (open && !openedRef.current) {
      openedRef.current = true;
      void load();
    }
    if (!open) openedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fetchedFor]);

  // Not a /docs/ URL we can render inline — nothing to show; callers with a
  // visible trigger (DocReference) degrade to a plain link before reaching us.
  if (!ref) return null;

  const openFullDocs = (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
    >
      Open full docs
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{state.data?.title ?? "Documentation"}</SheetTitle>
          <SheetDescription className="sr-only">Referenced documentation</SheetDescription>
          {openFullDocs}
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4">
          {lead}
          {state.loading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : state.error ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>Could not load this doc.</p>
              {openFullDocs}
            </div>
          ) : state.data ? (
            <div className="doc-panel">
              {/* Resolve doc-relative links (sibling .md, ../adr/*.md, #anchors)
                  against the doc's own hosted URL so a click opens the real doc
                  instead of 404-ing under the current app route. */}
              <MarkdownContent text={state.data.markdown} linkBaseUrl={url} />
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
