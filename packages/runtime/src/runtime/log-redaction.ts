// Redaction layer for the in-app Logs viewer's "share" mode (ADR
// logs-viewing.md). Reuses the crash-report redaction so "safe to share" has a
// single definition: REPORT_SECRET_PATTERNS + literal secrets-env scrubbing,
// via redactReportText. This module adds NO new secret regexes.
//
// runtime.jsonl `data` payloads are not redacted at write time and can carry
// secrets/tokens/user content, so a redacted entry mirrors a crash report: keep
// only `{at, message}` (message scrubbed) and DROP `data` entirely. Raw stdout/
// web lines each pass through redactReportText.

import { redactReportText, type RedactOptions } from "./crash-report";
import type { LogTail, RuntimeLogEntry } from "../state/logs";

export function redactLogTail(tail: LogTail, opts: RedactOptions = {}): LogTail {
  const entries: RuntimeLogEntry[] | undefined = tail.entries?.map((entry) => ({
    at: entry.at,
    message: typeof entry.message === "string" ? redactReportText(entry.message, opts) : entry.message
    // `data` is intentionally dropped — it is never carried into a redacted tail.
  }));
  const lines: string[] | undefined = tail.lines?.map((line) => redactReportText(line, opts));
  return {
    stream: tail.stream,
    truncated: tail.truncated,
    ...(entries ? { entries } : {}),
    ...(lines ? { lines } : {})
  };
}
