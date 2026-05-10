export type PhaseIndicatorPhase = "thinking" | "working" | "receiving";

export function PhaseIndicator({
  phase
}: {
  phase: PhaseIndicatorPhase;
}) {
  const label = phase === "thinking" ? "Thinking" : phase === "working" ? "Working" : "Receiving";
  return (
    <div className="flex min-h-8 items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="inline-flex items-center gap-1" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" />
      </div>
    </div>
  );
}
