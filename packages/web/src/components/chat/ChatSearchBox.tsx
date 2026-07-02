import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// In-chat "find in conversation" control — sits in the agent header (design
// `zFqWM`). Collapsed it's the muted "Search in chat" pill from the design;
// focusing/clicking expands it into a text input with a match readout and
// prev/next chevrons. Fully controlled: the chat surface owns the query and
// the active-match index and computes matches over the loaded transcript.
export function ChatSearchBox({
  value,
  onChange,
  matchCount,
  activeIndex,
  onPrev,
  onNext,
  onClose
}: {
  value: string;
  onChange: (q: string) => void;
  matchCount: number;
  activeIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const expanded = focused || value !== "";

  // Auto-focus the input when expanding so a click on the pill drops straight
  // into typing.
  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  const close = () => {
    setFocused(false);
    onClose();
    inputRef.current?.blur();
  };

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setFocused(true)}
        className="hidden items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground sm:flex"
      >
        <Search className="size-3.5" />
        Search in chat
      </button>
    );
  }

  const readout =
    matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : value !== "" ? "No results" : "";

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-card pl-2.5 pr-1.5 py-1">
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        placeholder="Search in chat"
        className="w-36 bg-transparent text-[12px] font-medium text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
      {readout ? (
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
          {readout}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onPrev}
        disabled={matchCount === 0}
        aria-label="Previous match"
        className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
      >
        <ChevronUp className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label="Next match"
        className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
      >
        <ChevronDown className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={close}
        aria-label="Close search"
        className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
