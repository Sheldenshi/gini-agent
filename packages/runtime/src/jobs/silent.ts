// True when the model's reply signals "nothing to deliver": either exactly the
// sentinel, or the sentinel on its own TRAILING line after a no-op preamble
// (e.g. "No change since baseline.\n\n[SILENT]"). A LEADING/inline sentinel
// ("[SILENT] but here's an update") still delivers — preserving the documented
// prefix-rejection contract (see src/jobs/finalize.ts and the tests at
// src/jobs.test.ts:2581 / src/execution/chat-task.test.ts:1709).
export function isSilentReply(raw: string | undefined | null): boolean {
  const text = raw?.trim();
  if (!text) return false; // empty handled by each caller as before
  if (text === "[SILENT]") return true;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 && lines[lines.length - 1] === "[SILENT]";
}
