"use client";

import { useState } from "react";
import { Slot } from "radix-ui";
import { DocSheet } from "@/components/DocSheet";
import { parseDocsUrl } from "@/lib/docs";

// Reusable trigger that renders an app-referenced doc inline in a slide-over
// (DocSheet) instead of linking out. `url` is the full hosted docs URL the
// runtime already emits. `children` must be an INTERACTIVE element (a button
// or link): Slot only merges a click handler onto it, so a plain span would
// be keyboard-inaccessible. Non-/docs/ URLs degrade to a plain external link.
export function DocReference({ url, children }: { url: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  // Not a /docs/ URL we can render inline — never break the link.
  if (!parseDocsUrl(url)) {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }

  return (
    <>
      <Slot.Root aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {children}
      </Slot.Root>
      <DocSheet url={url} open={open} onOpenChange={setOpen} />
    </>
  );
}
