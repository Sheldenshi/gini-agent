import { cn } from "@/lib/utils";

export type ChatTab = "messages" | "threads" | "jobs";

interface TabSpec {
  id: ChatTab;
  label: string;
  count?: number;
}

// Chat tab bar — design `i2BaA`. The active tab gets a 2px white bottom
// border; inactive labels are muted. Threads/Jobs carry an optional count
// pill. Underline lives on the label row so it hugs the text width like the
// design.
export function ChatTabBar({
  active,
  onChange,
  threadCount,
  jobCount,
  hideJobsTab
}: {
  active: ChatTab;
  onChange: (tab: ChatTab) => void;
  threadCount?: number;
  jobCount?: number;
  hideJobsTab?: boolean;
}) {
  const tabs: TabSpec[] = [
    { id: "messages", label: "Messages" },
    { id: "threads", label: "Threads", count: threadCount },
    ...(hideJobsTab ? [] : [{ id: "jobs", label: "Jobs", count: jobCount } as TabSpec])
  ];
  return (
    <div className="flex shrink-0 items-end gap-1.5 border-b border-[#1C1C1E] px-7">
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
                ? "border-b-2 border-white text-foreground"
                : "border-b-2 border-transparent text-[#9A9AA0] hover:text-foreground"
            )}
          >
            {tab.label}
            {tab.count ? (
              <span className="flex items-center justify-center rounded-full border border-[#26262C] bg-[#1C1C22] px-1.5 py-px text-[11px] font-bold text-[#C2C2C8]">
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
