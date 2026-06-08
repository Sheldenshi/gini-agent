import { Search } from "lucide-react";
import { AgentAvatar } from "./AgentAvatar";
import { formatRelativeTime } from "./relative-time";

// Per-agent (or channel) chat header — design `zFqWM`. 52px colored-initial
// avatar, name, a muted "last active …" status row, and a right-side
// affordance. When `right` is provided (the chat surface passes a wired
// in-chat search control) it renders there; otherwise the static "Search in
// chat" pill stands in for design parity on surfaces with no transcript.
export function AgentChatHeader({
  name,
  seed,
  lastActiveAt,
  subtitle,
  right,
  showAvatar,
  titleAction
}: {
  name: string;
  seed?: string;
  lastActiveAt?: string;
  subtitle?: string;
  right?: React.ReactNode;
  showAvatar?: boolean;
  titleAction?: React.ReactNode;
}) {
  const lastActive = lastActiveAt ? formatRelativeTime(lastActiveAt) : "";
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-7 py-4">
      <div className="flex min-w-0 items-center gap-4">
        {showAvatar !== false ? (
          <AgentAvatar name={name} seed={seed} size={52} className="border border-border" />
        ) : null}
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-[19px] font-bold leading-none text-foreground">{name}</h1>
          <div className="flex items-center gap-1.5 text-[12px] leading-none">
            {subtitle ? (
              <span className="font-medium text-muted-foreground">{subtitle}</span>
            ) : lastActive ? (
              <span className="font-medium text-muted-foreground">last active {lastActive}</span>
            ) : null}
          </div>
        </div>
        {titleAction}
      </div>
      {right ?? (
        <div className="hidden items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground sm:flex">
          <Search className="size-3.5" />
          Search in chat
        </div>
      )}
    </header>
  );
}
