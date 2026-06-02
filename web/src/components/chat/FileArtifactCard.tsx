"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { fetchWorkspaceFile } from "@/lib/api";

// Always-visible card for a file the agent generated in this exchange. The
// chat otherwise buries the file_write call inside the collapsed tool group,
// so this surfaces the result with a one-click viewer. Content is only
// fetched when the dialog opens (useQuery enabled: open).
export function FileArtifactCard({ path }: { path: string; toolName: string }) {
  const [open, setOpen] = useState(false);
  const name = path.split("/").pop() ?? path;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2.5 rounded-lg border border-[#3A3A42] bg-[#2B2B31] px-3 py-2 text-left transition-colors hover:bg-[#33333B]"
        >
          <FileText className="size-[15px] shrink-0 text-[#9A9AA0]" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-[#D6D6DC]">{name}</span>
          <span className="shrink-0 text-[12px] text-[#9A9AA0]">View file</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <FileViewer path={path} name={name} open={open} />
      </DialogContent>
    </Dialog>
  );
}

function FileViewer({ path, name, open }: { path: string; name: string; open: boolean }) {
  const [copied, setCopied] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["workspace-file", path],
    queryFn: () => fetchWorkspaceFile(path),
    enabled: open
  });

  const onCopy = async () => {
    if (!data) return;
    await navigator.clipboard.writeText(data.absolutePath);
    setCopied(true);
    toast.success("Path copied");
    setTimeout(() => setCopied(false), 1500);
  };

  const isMarkdown = /\.(md|markdown)$/i.test(name);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="truncate font-mono">{name}</DialogTitle>
        {isLoading ? (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Loading…
          </div>
        ) : data ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
              {data.absolutePath}
            </span>
            <button
              type="button"
              onClick={onCopy}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Copy path"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
          </div>
        ) : null}
      </DialogHeader>
      <div className="max-h-[60vh] overflow-auto">
        {error ? (
          <p className="text-[13px] text-red-400/90">{error instanceof Error ? error.message : "Failed to load file"}</p>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        ) : data?.binary ? (
          <p className="text-[13px] text-muted-foreground">Binary file — {data.bytes} bytes</p>
        ) : data ? (
          isMarkdown ? (
            <>
              <MarkdownContent text={data.content ?? ""} />
              {data.truncated ? <p className="mt-2 text-[12px] text-muted-foreground">[truncated]</p> : null}
            </>
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-[#C8C8D2]">
              {data.content ?? ""}
              {data.truncated ? "\n\n[truncated]" : ""}
            </pre>
          )
        ) : null}
      </div>
    </>
  );
}
