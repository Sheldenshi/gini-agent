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
import { fetchWorkspaceFile, fileInlineUrl, fileRawUrl } from "@/lib/api";
import { parseCsv } from "@/lib/parse-csv";

type PreviewKind = "markdown" | "image" | "pdf" | "csv" | "text";

// Pick the render strategy for a file from its extension. Images and PDFs are
// embedded inline (via fileInlineUrl); markdown is rendered; csv/tsv become a
// table; everything else falls back to a text block (or the binary notice when
// the gateway flags the bytes as non-text).
function previewKind(filename: string): PreviewKind {
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "csv" || ext === "tsv") return "csv";
  return "text";
}

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
        className="flex w-full flex-col gap-0 border-l border-border bg-card p-0 data-[side=right]:sm:max-w-[720px]"
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
  const kind = previewKind(filename);

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
      <SheetDescription className="sr-only">{data?.absolutePath ?? path}</SheetDescription>
      <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-border px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[#D7DEFA] bg-[#EEF2FF] dark:border-[#2A3A6A] dark:bg-[#1B2540]"
            aria-hidden="true"
          >
            <FileText className="size-4 text-[#4277FB] dark:text-[#6B97FF]" />
          </span>
          <div className="flex min-w-0 items-baseline gap-1.5">
            {dir ? <span className="truncate font-mono text-xs text-muted-foreground">{dir}</span> : null}
            <SheetTitle className="truncate font-mono text-sm font-semibold text-foreground">{filename}</SheetTitle>
          </div>
          {ext ? (
            <span className="shrink-0 rounded-[5px] border border-[#D7DEFA] bg-[#EEF2FF] px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-[#4277FB] dark:border-[#243A6F] dark:bg-[#16264D] dark:text-[#8FB1FF]">
              {ext}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={fileRawUrl(path)}
            download={filename}
            className="flex items-center gap-1.5 rounded-[7px] border border-[#D7DEFA] bg-[#EEF2FF] px-2.5 py-1.5 text-xs font-semibold text-[#4277FB] transition-colors hover:bg-[#E0E8FF] dark:border-[#2A3A6A] dark:bg-[#1B2540] dark:text-[#8FB1FF] dark:hover:bg-[#22305A]"
          >
            <Download className="size-3.5" aria-hidden="true" />
            Download
          </a>
          <SheetClose
            className="flex size-8 items-center justify-center rounded-lg border border-border bg-transparent text-foreground transition-colors hover:bg-muted"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden="true" />
          </SheetClose>
        </div>
      </header>

      {kind === "pdf" ? (
        // PDFs embed inline and fill the drawer body, so this container is
        // full-height with no padding (unlike the padded scroll body the other
        // formats use). The iframe renders as soon as the path is known — it
        // doesn't wait on the JSON content query.
        <div className="min-h-0 flex-1">
          <iframe src={fileInlineUrl(path)} title={filename} className="size-full border-0" />
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-10 py-8">
          {kind === "image" ? (
            // Images embed inline and don't need the JSON content query. A
            // plain <img> is correct here: the source is raw BFF-streamed
            // workspace bytes, not an asset next/image can optimize.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={fileInlineUrl(path)}
              alt={filename}
              className="mx-auto max-w-full rounded-md"
            />
          ) : isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
            </div>
          ) : error ? (
            <p className="text-[13px] text-red-400/90">
              {error instanceof Error ? error.message : "Failed to load file"}
            </p>
          ) : data?.binary ? (
            <p className="text-[13px] text-muted-foreground">
              Binary file — {data.bytes} bytes. Use Download to save it.
            </p>
          ) : data ? (
            kind === "markdown" ? (
              <>
                <MarkdownContent text={data.content ?? ""} />
                {data.truncated ? <p className="mt-2 text-xs text-muted-foreground">[truncated]</p> : null}
              </>
            ) : kind === "csv" ? (
              <CsvTable
                content={data.content ?? ""}
                delimiter={filename.toLowerCase().endsWith(".tsv") ? "\t" : ","}
                truncated={data.truncated}
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words rounded-[10px] border border-border bg-muted p-4 font-mono text-[13px] leading-relaxed text-foreground">
                {data.content ?? ""}
                {data.truncated ? "\n\n[truncated]" : ""}
              </pre>
            )
          ) : null}
        </div>
      )}

      <footer className="flex h-[44px] shrink-0 items-center justify-between border-t border-border bg-muted px-6">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {data?.absolutePath ?? path}
        </span>
        <button
          type="button"
          onClick={onCopy}
          disabled={!data}
          className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
          Copy path
        </button>
      </footer>
    </>
  );
}

// Render parsed CSV/TSV content as a table: the first row is the header, the
// rest are body rows. Empty/whitespace-only content shows the binary-style
// muted notice instead of an empty grid.
function CsvTable({
  content,
  delimiter,
  truncated
}: {
  content: string;
  delimiter: string;
  truncated: boolean;
}) {
  if (!content.trim()) {
    return <p className="text-[13px] text-muted-foreground">Empty file.</p>;
  }
  const rows = parseCsv(content, delimiter);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  return (
    <>
      <div className="overflow-auto rounded-[10px] border border-border">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr>
              {header.map((cell, c) => (
                <th
                  key={c}
                  className="whitespace-nowrap border-b border-border bg-muted px-3 py-1.5 text-left font-semibold text-muted-foreground"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className="whitespace-nowrap border-b border-border px-3 py-1.5 text-left text-foreground"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated ? <p className="mt-2 text-xs text-muted-foreground">[truncated]</p> : null}
    </>
  );
}
