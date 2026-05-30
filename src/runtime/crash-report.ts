// Crash-report capture (pure, fully unit-testable).
//
// A crash handler (src/runtime/crash-handlers.ts) and the watchdog build a
// structured report here, fingerprint the error so recurrences dedupe to one
// GitHub issue, redact every secret/token/user-content byte before the text
// can reach an external issue body, and persist the report + per-fingerprint
// rate-limit state under <stateRoot>/crash-reports/.
//
// This module deliberately has no gh/launchd/process side effects beyond the
// synchronous file writes — the filing path lives in
// src/cli/commands/report-crash.ts so the build/fingerprint/redact logic stays
// pure and testable without spawning anything.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { baseStateRoot } from "../paths";
import { SECRET_PATTERNS, redactSecretValuesFromString } from "../tools/browser";

export type CrashSource = "runtime" | "web";

export interface CrashSysInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  giniCommit?: string;
}

// One parsed line from runtime.jsonl. Only `at` + `message` are ever carried
// into a report — the `data` payload can contain user/task content and is
// dropped before serialization.
export interface RuntimeLogLine {
  at?: string;
  message?: string;
  // `data` is intentionally NOT part of the serialized report; declared here
  // only so callers can pass raw parsed lines through without a separate map.
  data?: unknown;
}

export interface CrashReport {
  instance: string;
  source: CrashSource;
  supervisor: "launchd" | null;
  fingerprint: string;
  at: string;
  error: { name: string; message: string; stack: string };
  sysInfo: CrashSysInfo;
  // Each entry keeps only the event name + timestamp (no data payload).
  logTail: Array<{ at?: string; message?: string }>;
}

export interface BuildCrashReportArgs {
  instance: string;
  supervisor: "launchd" | null;
  error: unknown;
  source: CrashSource;
  logTail: RuntimeLogLine[];
  sysInfo: CrashSysInfo;
  clock: () => Date;
}

function errorParts(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "",
      stack: error.stack || ""
    };
  }
  return { name: "NonError", message: String(error), stack: "" };
}

// Strip volatile bytes that differ between two otherwise-identical crashes so
// they fingerprint to the same hash:
//   - absolute paths -> basename ("/a/b/c/server.ts" -> "server.ts")
//   - ":line:col" and ":line" trailing numbers
//   - hex addresses (0x...)
//   - bare pids and other long digit runs
//   - UUIDs
//   - ISO-8601 timestamps
// The order matters: timestamps/uuids first (they contain digits the later
// rules would chew up), then paths, then the numeric noise.
export function normalizeForFingerprint(text: string): string {
  let out = text;
  // ISO-8601 timestamps (e.g. 2026-05-29T12:34:56.789Z).
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>");
  // UUIDs.
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
  // Hex addresses.
  out = out.replace(/0x[0-9a-f]+/gi, "<hex>");
  // Absolute paths -> basename. Match a run of non-space, non-paren path
  // characters that starts at a `/` and keep only the final segment.
  out = out.replace(/\/[^\s():]+/g, (match) => basename(match));
  // ":line:col" / ":line" trailing position info.
  out = out.replace(/:\d+(?::\d+)?/g, ":<n>");
  // Any remaining standalone digit runs (pids, ports, counters).
  out = out.replace(/\b\d+\b/g, "<n>");
  return out;
}

// sha256 over the normalized "name: message" plus the top-5 normalized stack
// frames. Two crashes that differ only in paths/line numbers/pids/timestamps
// produce the SAME fingerprint; a different message or call site produces a
// different one.
export function fingerprint(error: unknown): string {
  const { name, message, stack } = errorParts(error);
  const head = normalizeForFingerprint(`${name}:${message}`);
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, 5)
    .map((line) => normalizeForFingerprint(line));
  const canonical = [head, ...frames].join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

// Extended secret-pattern list applied to report text before it can reach an
// external issue body. Reuses the repo's existing browser SECRET_PATTERNS and
// extends with the gh token forms and bearer/authorization header shapes.
// Each pattern carries the global flag so String.replace swaps every match.
const REPORT_SECRET_PATTERNS: RegExp[] = [
  ...SECRET_PATTERNS.map((p) => new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g")),
  /gh[opsur]_[A-Za-z0-9]{20,}/g,
  /Bearer\s+\S+/gi,
  /Authorization:\s*\S+/gi
];

export interface RedactOptions {
  // Body of ~/.gini/secrets.env (KEY=value lines). Every literal value is
  // scrubbed verbatim so a hand-edited or odd-format key still gets caught
  // even if it doesn't match a pattern above.
  secretsEnvBody?: string;
  // The per-instance tunnel secret literal.
  tunnelSecret?: string;
}

// Parse literal secret values out of a secrets.env body. Reuses the same
// `export KEY=value` / bare `KEY=value` shape the writer emits; values may be
// single- or double-quoted. We only need the raw VALUES (not key names) to
// feed redactSecretValuesFromString.
function secretsEnvValues(body: string): string[] {
  const values: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(line);
    if (!match) continue;
    let raw = (match[1] ?? "").trim();
    if (raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))) {
      raw = raw.slice(1, -1);
    }
    if (raw.length > 0) values.push(raw);
  }
  return values;
}

// Redact secrets/tokens from arbitrary report text. Applies the extended
// pattern list, then scrubs the literal secrets-env values and tunnel secret.
// Default to dropping rather than including: pattern redaction runs first so a
// token is removed even when its literal value isn't in the provided lists.
export function redactReportText(text: string, opts: RedactOptions = {}): string {
  if (!text) return text;
  let out = text;
  for (const pattern of REPORT_SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  const literals: string[] = [];
  if (opts.secretsEnvBody) literals.push(...secretsEnvValues(opts.secretsEnvBody));
  if (opts.tunnelSecret) literals.push(opts.tunnelSecret);
  if (literals.length > 0) out = redactSecretValuesFromString(out, literals);
  return out;
}

export function buildCrashReport(args: BuildCrashReportArgs): CrashReport {
  const { instance, supervisor, error, source, logTail, sysInfo, clock } = args;
  const error_ = errorParts(error);
  // Keep only the event name + timestamp per log line. The `data` payload can
  // carry user/task content and is dropped entirely.
  const trimmedTail = logTail.map((line) => ({ at: line.at, message: line.message }));
  return {
    instance,
    source,
    supervisor,
    fingerprint: fingerprint(error),
    at: clock().toISOString(),
    error: error_,
    sysInfo,
    logTail: trimmedTail
  };
}

export function crashReportsDir(): string {
  return join(baseStateRoot(), "crash-reports");
}

// Synchronous write so a crash handler can persist before exiting. Filename is
// <iso-ts-with-safe-chars>-<fingerprint>.json under <stateRoot>/crash-reports/.
export function writeCrashReportFile(report: CrashReport): string {
  const dir = crashReportsDir();
  mkdirSync(dir, { recursive: true });
  const safeTs = report.at.replace(/[:.]/g, "-");
  const path = join(dir, `${safeTs}-${report.fingerprint}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export interface RateLimitState {
  lastFiledAt: string | null;
  lastCommentAt: string | null;
  commentCount: number;
}

function rateLimitStatePath(fingerprint: string): string {
  return join(crashReportsDir(), `${fingerprint}.state.json`);
}

export function readRateLimitState(fingerprint: string): RateLimitState {
  const path = rateLimitStatePath(fingerprint);
  if (!existsSync(path)) {
    return { lastFiledAt: null, lastCommentAt: null, commentCount: 0 };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RateLimitState>;
    return {
      lastFiledAt: typeof parsed.lastFiledAt === "string" ? parsed.lastFiledAt : null,
      lastCommentAt: typeof parsed.lastCommentAt === "string" ? parsed.lastCommentAt : null,
      commentCount: typeof parsed.commentCount === "number" ? parsed.commentCount : 0
    };
  } catch {
    return { lastFiledAt: null, lastCommentAt: null, commentCount: 0 };
  }
}

export function writeRateLimitState(fingerprint: string, state: RateLimitState): void {
  const dir = crashReportsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(rateLimitStatePath(fingerprint), `${JSON.stringify(state)}\n`);
}
