import { cn } from "@/lib/utils";

export function Avatar({ emoji = "🦑", className }: { emoji?: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-base leading-none select-none",
        className
      )}
      aria-hidden="true"
    >
      {emoji}
    </div>
  );
}
