"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { Copy, Download, RefreshCw } from "lucide-react";
import type { LogStream, LogTail, RuntimeLogEntry } from "@runtime/state/logs";

// GET /api/logs returns the on-disk tail plus the `redacted` flag the endpoint
// stamps on the response.
type LogsResponse = LogTail & { redacted: boolean };

const STREAMS: { value: LogStream; label: string }[] = [
  { value: "runtime", label: "Runtime" },
  { value: "stdout", label: "Stdout" },
  { value: "web", label: "Web" }
];

// Render the currently-displayed view as plain text for copy/download. Mirrors
// what the page shows: structured runtime entries collapse to a tab-separated
// line (with the JSON data appended only when present and not redacted), raw
// streams pass through line-for-line.
function tailToText(tail: LogTail): string {
  if (tail.entries) {
    return tail.entries
      .map((entry) => {
        const head = [entry.at, entry.message].filter(Boolean).join("\t");
        const data = entry.data !== undefined ? `\t${JSON.stringify(entry.data)}` : "";
        return `${head}${data}`;
      })
      .join("\n");
  }
  return (tail.lines ?? []).join("\n");
}

export default function LogsPage() {
  const [stream, setStream] = useState<LogStream>("runtime");
  const [redact, setRedact] = useState(false);

  const logs = useQuery<LogsResponse>({
    queryKey: ["logs", stream, redact],
    queryFn: () => api<LogsResponse>(`/logs?stream=${stream}&redact=${redact}&limit=500`)
  });

  const tail = logs.data;
  const text = useMemo(() => (tail ? tailToText(tail) : ""), [tail]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Logs copied");
    } catch {
      toast.error("Couldn't copy logs");
    }
  };

  const download = () => {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `gini-${stream}${redact ? "-redacted" : ""}.log`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const isEmpty =
    tail !== undefined && (tail.entries?.length ?? 0) === 0 && (tail.lines?.length ?? 0) === 0;

  return (
    <>
      <PageHeader
        title="Logs"
        description="View this instance's runtime logs and export a redacted copy to share"
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-pressed={redact}
              onClick={() => setRedact((value) => !value)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                redact
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:border-primary/40"
              )}
            >
              Redact for sharing
            </button>
            <Button size="sm" variant="outline" onClick={() => logs.refetch()} disabled={logs.isFetching}>
              <RefreshCw className={cn("size-3.5", logs.isFetching && "animate-spin")} />
              Refresh
            </Button>
            <Button size="sm" variant="outline" onClick={copy} disabled={!text}>
              <Copy className="size-3.5" />
              Copy
            </Button>
            <Button size="sm" variant="outline" onClick={download} disabled={!text}>
              <Download className="size-3.5" />
              Download
            </Button>
          </div>
        }
      />
      <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4 md:p-6">
        <Tabs value={stream} onValueChange={(value) => setStream(value as LogStream)}>
          <TabsList className="self-start">
            {STREAMS.map((s) => (
              <TabsTrigger key={s.value} value={s.value}>
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Card className="flex flex-1 flex-col overflow-hidden">
          <CardContent className="flex-1 overflow-hidden p-0">
            <ScrollArea className="h-full">
              {logs.isError ? (
                <div className="p-4">
                  <EmptyState title="Couldn't load logs" description={(logs.error as Error).message} />
                </div>
              ) : isEmpty ? (
                <div className="p-4">
                  <EmptyState title="No log entries" description="This stream is empty for the current instance." />
                </div>
              ) : tail?.entries ? (
                <ul className="divide-y divide-border">
                  {tail.entries.map((entry, index) => (
                    <RuntimeEntryRow key={index} entry={entry} redacted={tail.redacted} />
                  ))}
                </ul>
              ) : (
                <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {(tail?.lines ?? []).join("\n")}
                </pre>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function RuntimeEntryRow({ entry, redacted }: { entry: RuntimeLogEntry; redacted?: boolean }) {
  // `data` is dropped server-side in redacted mode; only show it in raw mode
  // when the entry actually carries a payload.
  const showData = !redacted && entry.data !== undefined;
  return (
    <li className="flex items-start gap-3 px-4 py-2 font-mono text-[11px]">
      <span className="shrink-0 text-muted-foreground">
        {entry.at ? new Date(entry.at).toLocaleTimeString() : "—"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words text-foreground">{entry.message ?? ""}</p>
        {showData ? (
          <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
            {JSON.stringify(entry.data)}
          </pre>
        ) : null}
      </div>
    </li>
  );
}
