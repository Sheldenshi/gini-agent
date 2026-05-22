import type { SystemNoteBlock } from "@runtime/types";

// Muted italic line used for terminal flags ("Cancelled", "Failed: …") and
// other operator-attributed notes. Kept low-key so it doesn't pull focus
// from the assistant's reply.
export function BlockSystemNote({ block }: { block: SystemNoteBlock }) {
  return (
    <p className="text-xs italic text-muted-foreground">{block.text}</p>
  );
}
