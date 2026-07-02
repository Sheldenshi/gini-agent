// Pure tail reader for the per-instance log files under logDir(instance).
//
// Three streams are exposed to the in-app Logs viewer (ADR logs-viewing.md):
//   - runtime → runtime.jsonl (structured `{at,instance,message,data}` lines)
//   - stdout  → runtime-stdout.log (raw Bun runtime stdout/stderr)
//   - web     → web.log (raw Next.js dev-server stdout/stderr)
//
// Structured runtime lines are parsed into entries; an unparseable line is
// skipped rather than thrown (a half-written or hand-edited line must not wedge
// the viewer). The raw streams are returned line-for-line. A missing file
// yields an empty tail. This module has no redaction concern — that is layered
// on in src/runtime/log-redaction.ts.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Instance } from "../types";
import { logDir } from "../paths";

export type LogStream = "runtime" | "stdout" | "web";

const STREAM_FILES: Record<LogStream, string> = {
  runtime: "runtime.jsonl",
  stdout: "runtime-stdout.log",
  web: "web.log"
};

export function isLogStream(value: string): value is LogStream {
  return value === "runtime" || value === "stdout" || value === "web";
}

// One parsed line from runtime.jsonl. `data` can carry user/task content and is
// dropped before a redacted export (see redactLogTail).
export interface RuntimeLogEntry {
  at?: string;
  message?: string;
  data?: unknown;
}

export interface LogTail {
  stream: LogStream;
  // Present for the structured `runtime` stream only.
  entries?: RuntimeLogEntry[];
  // Present for the raw `stdout` / `web` streams only.
  lines?: string[];
  // The file held more than `limit` lines, so the head was dropped.
  truncated: boolean;
}

// Read the last `limit` lines of a stream. `runtime` is parsed into entries;
// `stdout`/`web` are returned as raw lines. A missing file is an empty tail.
export function readLogTail(instance: Instance, stream: LogStream, limit: number): LogTail {
  const path = join(logDir(instance), STREAM_FILES[stream]);
  if (!existsSync(path)) {
    return stream === "runtime"
      ? { stream, entries: [], truncated: false }
      : { stream, lines: [], truncated: false };
  }
  const rawLines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
  const truncated = rawLines.length > limit;
  const tail = truncated ? rawLines.slice(-limit) : rawLines;
  if (stream === "runtime") {
    const entries: RuntimeLogEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line) as RuntimeLogEntry);
      } catch {
        // Skip an unparseable line; keep the rest of the tail.
      }
    }
    return { stream, entries, truncated };
  }
  return { stream, lines: tail, truncated };
}
