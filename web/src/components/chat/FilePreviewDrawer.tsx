"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Download, FileText, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle
} from "@/components/ui/sheet";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { fetchWorkspaceFile, fileRawUrl } from "@/lib/api";

// Notion-style right-side "side peek" previewer for a single generated file.
// The Sheet (Radix Dialog) supplies the slide-in, dimmed scrim, Esc,
// click-outside, and focus trap; this component fills in the header
// (identity + Download + Close), the scrollable rendered body, and a footer
// carrying the absolute path + copy. Open is controlled by the parent via
// `path` (open when non-null); content is only fetched while open.
export function FilePreviewDrawer({
  path,
  onOpenChange
}: {
  path: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={path !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col gap-0 border-l border-[#2A2B33] bg-[#101116] p-0 data-[side=right]:sm:max-w-[720px]"
      >
        {path !== null ? <DrawerBody path={path} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["workspace-file", path],
    queryFn: () => fetchWorkspaceFile(path),
    enabled: true
  });

  const lastSlash = path.lastIndexOf("/");
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dir = lastSlash > 0 ? path.slice(0, lastSlash + 1) : "";
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toUpperCase() : "";
  const isMarkdown = /\.(md|markdown)$/i.test(filename);

  const onCopy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.absolutePath);
      setCopied(true);
      toast.success("Path copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Failed to copy path");
    }
  };

  return (
    <>
      <SheetDescription className="sr-only">{path}</SheetDescription>
      <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-[#23232A] px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[#2A3A6A] bg-[#1B2540]"
            aria-hidden="true"
          >
            <FileText className="size-4 text-[#6B97FF]" />
          </span>
          <span className="flex min-w-0 items-baseline gap-1.5">
            {dir ? <span className="shrink-0 truncate font-mono text-xs text-[#7A7A80]">{dir}</span> : null}
            <SheetTitle className="truncate font-mono text-sm font-semibold text-white">{filename}</SheetTitle>
          </span>
          {ext ? (
            <span className="shrink-0 rounded-[5px] border border-[#243A6F] bg-[#16264D] px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-[#8FB1FF]">
              {ext}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={fileRawUrl(path)}
            download={filename}
            className="flex items-center gap-1.5 rounded-[7px] border border-[#2A3A6A] bg-[#1B2540] px-2.5 py-1.5 text-xs font-semibold text-[#8FB1FF] transition-colors hover:bg-[#22305A]"
          >
            <Download className="size-3.5" aria-hidden="true" />
            Download
          </a>
          <SheetClose
            className="flex size-8 items-center justify-center rounded-lg border border-[#2A2B33] bg-transparent text-[#B6B6BC] transition-colors hover:bg-[#1B1C22]"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden="true" />
          </SheetClose>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-10 py-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-[#9A9AA0]" aria-label="Loading" />
          </div>
        ) : error ? (
          <p className="text-[13px] text-red-400/90">
            {error instanceof Error ? error.message : "Failed to load file"}
          </p>
        ) : data?.binary ? (
          <p className="text-[13px] text-[#9A9AA0]">
            Binary file — {data.bytes} bytes. Use Download to save it.
          </p>
        ) : data ? (
          isMarkdown ? (
            <>
              <MarkdownContent text={data.content ?? ""} />
              {data.truncated ? <p className="mt-2 text-xs text-[#9A9AA0]">[truncated]</p> : null}
            </>
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-[10px] border border-[#23232A] bg-[#0E0F14] p-4 font-mono text-[13px] leading-relaxed text-[#D6D6DC]">
              {data.content ?? ""}
              {data.truncated ? "\n\n[truncated]" : ""}
            </pre>
          )
        ) : null}
      </div>

      <footer className="flex h-[44px] shrink-0 items-center justify-between border-t border-[#23232A] bg-[#0E0F14] px-6">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-[#7A7A80]">
          {data?.absolutePath ?? path}
        </span>
        <button
          type="button"
          onClick={onCopy}
          disabled={!data}
          className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-[#9A9AA0] transition-colors hover:text-[#D6D6DC] disabled:opacity-50"
        >
          {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
          Copy path
        </button>
      </footer>
    </>
  );
}
