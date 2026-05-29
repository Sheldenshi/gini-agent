import Image from "next/image";
import { cn } from "@/lib/utils";

export function Avatar({ emoji, className }: { emoji?: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center text-base leading-none select-none overflow-hidden",
        className
      )}
      aria-hidden="true"
    >
      {emoji ? (
        emoji
      ) : (
        <Image
          src="/gini-agent-logo.png"
          alt="Gini"
          width={36}
          height={36}
          className="h-full w-full object-cover"
        />
      )}
    </div>
  );
}
