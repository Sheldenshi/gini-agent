import { Globe } from "lucide-react";
import type { ToolCallBlock, ToolCallStatus } from "@runtime/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_TONES: Record<ToolCallStatus, string> = {
  running: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  ok: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  error: "bg-red-500/10 text-red-400 border-red-500/30",
  denied: "bg-red-500/10 text-red-400 border-red-500/30"
};

const STATUS_LABELS: Record<ToolCallStatus, string> = {
  running: "running",
  ok: "ok",
  error: "error",
  denied: "denied"
};

export function BlockToolCall({ block }: { block: ToolCallBlock }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="font-semibold text-foreground">{block.displayLabel}</span>
      {block.argsPreview ? (
        <span className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {block.argsPreview}
        </span>
      ) : null}
      <Badge
        variant="outline"
        className={cn(
          "font-mono text-[10px] font-semibold uppercase tracking-wide",
          STATUS_TONES[block.status]
        )}
      >
        {STATUS_LABELS[block.status]}
      </Badge>
      {block.errorMessage ? (
        <span className="basis-full pl-1 text-[11px] text-red-400/90">
          {block.errorMessage}
        </span>
      ) : null}
    </div>
  );
}
