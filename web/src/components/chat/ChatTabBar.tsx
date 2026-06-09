import { cn } from "@/lib/utils";

export type ChatTab = "messages" | "threads" | "jobs" | "settings";

interface TabSpec {
  id: ChatTab;
  label: string;
  count?: number;
}

// Chat tab bar — design `i2BaA`. The active tab gets a 2px white bottom
// border; inactive labels are muted. Threads/Jobs carry an optional count
// pill. Underline lives on the label row so it hugs the text width like the
// design. Jobs and Settings are per-agent surfaces; the caller hides Jobs on
// channels and Settings on any pinned session (both can show another agent's
// session), so their visibility flags are passed separately.
export function ChatTabBar({
  active,
  onChange,
  threadCount,
  jobCount,
  hideJobsTab,
  hideSettingsTab
}: {
  active: ChatTab;
  onChange: (tab: ChatTab) => void;
  threadCount?: number;
  jobCount?: number;
  hideJobsTab?: boolean;
  hideSettingsTab?: boolean;
}) {
  const tabs: TabSpec[] = [
    { id: "messages", label: "Messages" },
    { id: "threads", label: "Threads", count: threadCount },
    ...(hideJobsTab ? [] : [{ id: "jobs", label: "Jobs", count: jobCount } as TabSpec]),
    ...(hideSettingsTab ? [] : [{ id: "settings", label: "Settings" } as TabSpec])
  ];
  return (
    <div className="flex shrink-0 items-end gap-1.5 border-b border-border px-7">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={cn(
              "flex items-center gap-2 px-3 py-3.5 text-[13px] font-semibold transition-colors",
              isActive
                ? "border-b-2 border-foreground text-foreground"
                : "border-b-2 border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
            {tab.count ? (
              <span className="flex items-center justify-center rounded-full border border-border bg-muted px-1.5 py-px text-[11px] font-bold text-foreground">
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
