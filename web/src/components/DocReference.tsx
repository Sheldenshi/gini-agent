"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  Sheet,
  SheetTrigger,
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

// Reusable trigger that renders an app-referenced doc inline in a slide-over
// instead of linking out. `url` is the full hosted docs URL the runtime already
// emits; the relative gateway path (+ anchor) is derived from it, and the
// original url stays the "Open full docs ↗" escape hatch. `children` is the
// trigger element (a button, a link-styled span, …).
export function DocReference({ url, children }: { url: string; children: React.ReactNode }) {
  const ref = parseDocsUrl(url);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FetchState>({ loading: false });

  // Not a /docs/ URL we can render inline — never break the link.
  if (!ref) {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }

  async function load() {
    if (state.data || state.loading) return;
    setState({ loading: true });
    try {
      const query = ref!.anchor ? `?section=${encodeURIComponent(ref!.anchor)}` : "";
      const data = await api<DocSection>(`/docs/${ref!.path}${query}`);
      setState({ loading: false, data });
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

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
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
    >
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent side="right" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{state.data?.title ?? "Documentation"}</SheetTitle>
          <SheetDescription className="sr-only">Referenced documentation</SheetDescription>
          {openFullDocs}
        </SheetHeader>
        <div className="px-4 pb-4">
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
              <MarkdownContent text={state.data.markdown} />
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
