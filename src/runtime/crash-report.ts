// Crash-report capture (pure, fully unit-testable).
//
// A crash handler (src/runtime/crash-handlers.ts) and the watchdog build a
// structured report here, fingerprint the error so recurrences dedupe to one
// GitHub issue, redact every secret/token/user-content byte before the text
// can reach an external issue body, and queue the report under
// <stateRoot>/crash-reports/pending/ plus per-fingerprint ask-rate-limit state.
//
// This module deliberately has no gh/launchd/process side effects beyond the
// synchronous file writes. The reports it queues are filed only after the user
// consents — the restart-ask glue (src/runtime/crash-recovery.ts) offers them
// in chat and the gini-bug-report skill does the actual filing, so the
// build/fingerprint/redact/queue logic stays pure and testable.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { baseStateRoot } from "../paths";
import { SECRET_PATTERNS, redactSecretValuesFromString } from "../tools/browser";
import { unquoteSecretsValue } from "../state/secrets-env";

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
  // Best-effort literal-redaction input. Pattern-based redaction always runs;
  // this scrubs the exact secrets-env values when provided. A producer that
  // can't read them (e.g. a crash path) passes undefined and still gets
  // pattern redaction.
  secretsEnvBody?: string;
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
  // Match the WHOLE header value to end-of-line, not just the first
  // whitespace-delimited token. `Authorization: Basic <b64>` and a bare
  // `Authorization: <token>` (no scheme) both have a single-space-then-value
  // shape where \S+ would leave the trailing token(s) behind.
  /Authorization:\s*[^\r\n]+/gi
];

export interface RedactOptions {
  // Body of ~/.gini/secrets.env (KEY=value lines). Every literal value is
  // scrubbed verbatim so a hand-edited or odd-format key still gets caught
  // even if it doesn't match a pattern above.
  secretsEnvBody?: string;
}

// Parse literal secret values out of a secrets.env body. Reuses the same
// `export KEY=value` / bare `KEY=value` shape the writer emits; values may be
// single- or double-quoted. We only need the raw VALUES (not key names) to
// feed redactSecretValuesFromString. Unquoting goes through the repo's
// `unquoteSecretsValue` so the value we redact is exactly the value the
// runtime loaded — escaped/quoted forms are inverted identically rather than
// half-stripped, which would otherwise leak the escaped portion.
function secretsEnvValues(body: string): string[] {
  const values: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(line);
    if (!match) continue;
    const value = unquoteSecretsValue(match[1] ?? "");
    if (value.length > 0) values.push(value);
  }
  return values;
}

// Redact secrets/tokens from arbitrary report text. Applies the extended
// pattern list, then scrubs the literal secrets-env values. Default to
// dropping rather than including: pattern redaction runs first so a token is
// removed even when its literal value isn't in the provided lists.
export function redactReportText(text: string, opts: RedactOptions = {}): string {
  // A malformed log/error field can carry a non-string (e.g. a numeric
  // `message`). String.replace on a number throws, which would drop the whole
  // crash report — so pass any non-string through untouched. This guards every
  // call site (name/message/stack/logTail).
  if (typeof text !== "string") return text;
  if (!text) return text;
  let out = text;
  for (const pattern of REPORT_SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  const literals: string[] = [];
  if (opts.secretsEnvBody) literals.push(...secretsEnvValues(opts.secretsEnvBody));
  if (literals.length > 0) out = redactSecretValuesFromString(out, literals);
  return out;
}

export function buildCrashReport(args: BuildCrashReportArgs): CrashReport {
  const { instance, supervisor, error, source, logTail, sysInfo, clock } = args;
  // Fingerprint from the RAW error (a sha256 — safe to keep, and it must stay
  // stable so recurrences dedupe). Redaction only touches the human-readable
  // fields that reach the published issue body.
  const fp = fingerprint(error);
  const redactOpts: RedactOptions = {
    secretsEnvBody: args.secretsEnvBody
  };
  const raw = errorParts(error);
  // `name` reaches the published issue title AND body, so it crosses the same
  // secret trust boundary as message/stack — redact it too. The fingerprint
  // above is computed from the RAW error, so this doesn't perturb dedup.
  const error_ = {
    name: redactReportText(raw.name, redactOpts),
    message: redactReportText(raw.message, redactOpts),
    stack: redactReportText(raw.stack, redactOpts)
  };
  // Keep only the event name + timestamp per log line (the `data` payload can
  // carry user/task content and is dropped entirely), and redact the message
  // text that survives.
  const trimmedTail = logTail.map((line) => ({
    at: line.at,
    // Only redact a string message; a malformed non-string (e.g. a numeric
    // `message`) passes through untouched so the build never throws.
    message: typeof line.message === "string" ? redactReportText(line.message, redactOpts) : line.message
  }));
  return {
    instance,
    source,
    supervisor,
    fingerprint: fp,
    at: clock().toISOString(),
    error: error_,
    sysInfo,
    logTail: trimmedTail
  };
}

export function crashReportsDir(): string {
  return join(baseStateRoot(), "crash-reports");
}

// Queued reports awaiting a consent decision. A producer writes here; the
// restart-ask glue reads here; a "yes" moves the report to filed/, a "no"
// moves it to dismissed/.
export function pendingCrashReportsDir(): string {
  return join(crashReportsDir(), "pending");
}

// Reports the user consented to file (the skill moves them here once filed).
export function filedCrashReportsDir(): string {
  return join(crashReportsDir(), "filed");
}

// Reports the user declined to file.
export function dismissedCrashReportsDir(): string {
  return join(crashReportsDir(), "dismissed");
}

// Synchronous write so a crash handler can persist before exiting. Lands in the
// pending/ queue as <iso-ts-with-safe-chars>-<fingerprint>-<rand>.json; nothing
// is filed until the user consents on the next restart. The short random suffix
// keeps two same-millisecond, same-fingerprint reports (a tight crash loop)
// from clobbering each other.
export function writeCrashReportFile(report: CrashReport): string {
  const dir = pendingCrashReportsDir();
  mkdirSync(dir, { recursive: true });
  const safeTs = report.at.replace(/[:.]/g, "-");
  const suffix = randomBytes(4).toString("hex");
  const path = join(dir, `${safeTs}-${report.fingerprint}-${suffix}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

// Read + parse every report in the pending/ queue. An unparseable file is
// skipped rather than throwing — a half-written or corrupt report must not
// wedge the restart-ask path. Returns [] when the queue dir doesn't exist.
export function listPendingReports(): Array<{ path: string; report: CrashReport }> {
  const dir = pendingCrashReportsDir();
  if (!existsSync(dir)) return [];
  const out: Array<{ path: string; report: CrashReport }> = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    try {
      const report = JSON.parse(readFileSync(path, "utf8")) as CrashReport;
      out.push({ path, report });
    } catch {
      // Skip an unparseable report; keep the rest of the queue.
    }
  }
  return out;
}

// Move a pending report into filed/ or dismissed/ once its consent decision is
// resolved. renameSync within the same crash-reports tree is atomic; the sibling
// dir is created first so the move never fails on a missing target.
export function resolvePendingReport(path: string, outcome: "filed" | "dismissed"): string {
  const targetDir = outcome === "filed" ? filedCrashReportsDir() : dismissedCrashReportsDir();
  mkdirSync(targetDir, { recursive: true });
  const dest = join(targetDir, basename(path));
  renameSync(path, dest);
  return dest;
}

export interface RateLimitState {
  lastFiledAt: string | null;
  lastCommentAt: string | null;
  commentCount: number;
  // When this fingerprint was last surfaced to the user as a "want me to file
  // it?" question. Gates the restart-ask so a crash loop (or a respawn) doesn't
  // re-ask about the same crash on every boot. Null until first asked.
  lastAskedAt: string | null;
  // The open crash issue this fingerprint was last filed to. Once known, a
  // recurrence comments directly instead of searching — defeating GitHub's
  // search-indexing latency, which could otherwise let a crash loop file a
  // duplicate issue before the first one is indexed.
  issueNumber?: number;
}

function rateLimitStatePath(fingerprint: string): string {
  return join(crashReportsDir(), `${fingerprint}.state.json`);
}

export function readRateLimitState(fingerprint: string): RateLimitState {
  const path = rateLimitStatePath(fingerprint);
  if (!existsSync(path)) {
    return { lastFiledAt: null, lastCommentAt: null, commentCount: 0, lastAskedAt: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RateLimitState>;
    return {
      lastFiledAt: typeof parsed.lastFiledAt === "string" ? parsed.lastFiledAt : null,
      lastCommentAt: typeof parsed.lastCommentAt === "string" ? parsed.lastCommentAt : null,
      commentCount: typeof parsed.commentCount === "number" ? parsed.commentCount : 0,
      lastAskedAt: typeof parsed.lastAskedAt === "string" ? parsed.lastAskedAt : null,
      ...(typeof parsed.issueNumber === "number" ? { issueNumber: parsed.issueNumber } : {})
    };
  } catch {
    return { lastFiledAt: null, lastCommentAt: null, commentCount: 0, lastAskedAt: null };
  }
}

export function writeRateLimitState(fingerprint: string, state: RateLimitState): void {
  const dir = crashReportsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(rateLimitStatePath(fingerprint), `${JSON.stringify(state)}\n`);
}

// Stamp lastAskedAt for a fingerprint, preserving the rest of its state. Done
// BEFORE the ask is created so a crash that respawns the gateway mid-ask can't
// produce a second question for the same fingerprint.
export function markAsked(fingerprint: string, atIso: string): void {
  const state = readRateLimitState(fingerprint);
  writeRateLimitState(fingerprint, { ...state, lastAskedAt: atIso });
}

// True when this fingerprint was asked about within `windowMs` of `nowMs`. A
// fingerprint never asked (lastAskedAt === null) or with an unparseable stamp
// returns false so it's eligible to ask.
export function wasAskedRecently(fingerprint: string, nowMs: number, windowMs: number): boolean {
  const { lastAskedAt } = readRateLimitState(fingerprint);
  if (!lastAskedAt) return false;
  const askedMs = new Date(lastAskedAt).getTime();
  if (!Number.isFinite(askedMs)) return false;
  return nowMs - askedMs < windowMs;
}
