import {
  Brain,
  Terminal,
  Wrench,
  Globe,
  FileText,
  Search,
  type LucideIcon
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolCallSummary } from "@runtime/types";

// Map a tool name to a lucide icon + a humanized label. The mapping is
// intentionally loose — exact tool names vary across providers and skills,
// so we match on substrings rather than enumerating every catalog entry.
// Shell/file actions get the terminal glyph (matching Conductor's `>_`),
// "think"/reflection gets the brain glyph, and unknown tools fall back to
// a wrench.
function iconForTool(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n.includes("think") || n.includes("reflect")) return Brain;
  if (
    n.includes("bash") ||
    n.includes("exec") ||
    n.includes("terminal") ||
    n.includes("shell")
  ) {
    return Terminal;
  }
  if (n.includes("file") || n.includes("read") || n.includes("write")) {
    return FileText;
  }
  if (n.includes("search") || n.includes("grep") || n.includes("find")) {
    return Search;
  }
  if (n.includes("browser") || n.includes("fetch") || n.includes("http")) {
    return Globe;
  }
  return Wrench;
}

// Humanize a snake_case / dotted tool name into a short Title-Case-ish
// label for the row title. e.g. `terminal.exec` → "Terminal exec",
// `file_write` → "File write", `spawn_subagent` → "Spawn subagent".
function humanizeName(name: string): string {
  const cleaned = name.replace(/[._]/g, " ").trim();
  if (!cleaned) return name;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function ToolCallRow({ call }: { call: ToolCallSummary }) {
  const Icon = iconForTool(call.name);
  const isRunning = call.status === "running";
  const isError = call.status === "error";
  return (
    <div className="flex min-w-0 items-center gap-2 py-0.5 text-xs">
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          isError ? "text-destructive" : "text-muted-foreground"
        )}
        aria-hidden="true"
      />
      <span
        className={cn(
          "shrink-0 font-medium",
          isError ? "text-destructive" : "text-foreground/80",
          isRunning && "animate-pulse"
        )}
      >
        {humanizeName(call.name)}
      </span>
      {call.argsPreview ? (
        <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {call.argsPreview}
        </code>
      ) : null}
    </div>
  );
}
