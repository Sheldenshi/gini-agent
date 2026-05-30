// `gini report-crash --report <path>` — file a deduped GitHub issue for a
// crash report written by the runtime crash handler (or the watchdog).
//
// Invoked as a detached child by the crash handler AFTER the report file is on
// disk, so it survives the crashing process. The command never throws and
// never blocks: any failure (not under launchd, gh unauthed, rate-limited)
// resolves to exit 0 so it can't wedge a respawn or a watchdog tick.
//
// Filing is gated to launchd-supervised instances only (decision 3): the 40+
// throwaway conductor/test instances must not file issues. Recurrences of the
// same fingerprint reuse one open issue (hidden-marker dedup) and are
// rate-limited (>=1h between comments, hard cap 20) so a crash loop can't spam
// the tracker.

import { existsSync, readFileSync } from "node:fs";
import type { CliContext } from "../context";
import { flagValue } from "../args";
import { supervisor } from "../../integrations/launchd";
import {
  defaultGhRunner,
  ensureCrashLabel,
  findOpenIssueByFingerprint,
  fingerprintMarker,
  createCrashIssue,
  commentOnIssue,
  isGhAuthed,
  type GhRunner
} from "../../integrations/github-issues";
import {
  readRateLimitState,
  redactReportText,
  writeRateLimitState,
  type CrashReport,
  type RateLimitState
} from "../../runtime/crash-report";
import { secretsEnvPath } from "../../state/secrets-env";
import { readTunnelConfig } from "../../runtime/tunnel/config-store";
import { appendLog } from "../../state/trace";

// Minimum gap between comments on the same fingerprint's issue.
const COMMENT_MIN_INTERVAL_MS = 60 * 60 * 1000;
// Hard cap on comments per fingerprint before we silently drop recurrences.
const COMMENT_HARD_CAP = 20;

export interface ReportCrashDeps {
  gh?: GhRunner;
  clock?: () => Date;
  supervisorImpl?: () => "launchd" | null;
}

function truncate(text: string): string {
  const oneLine = text.split("\n")[0] ?? "";
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

// Read the secrets.env body (if present) for literal-value redaction. Failures
// are swallowed — pattern redaction still catches the common token shapes.
function readSecretsEnvBody(): string | undefined {
  try {
    const path = secretsEnvPath();
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function readTunnelSecret(instance: string): string | undefined {
  try {
    return readTunnelConfig(instance).secret;
  } catch {
    return undefined;
  }
}

// Assemble the redacted issue title AND body in one pass so both share the
// same redaction context. The TITLE is built from raw error.name/message, so
// it MUST be redacted before sending (the body redaction alone would leave a
// secret/user-content byte leaking via the title). Redact first, then
// truncate, so we never expose the head of an unredacted secret.
function buildIssueContent(report: CrashReport, instance: string): { title: string; body: string } {
  const secretsEnvBody = readSecretsEnvBody();
  const tunnelSecret = readTunnelSecret(instance);
  const redact = (text: string): string => redactReportText(text, { secretsEnvBody, tunnelSecret });

  const logLines = report.logTail
    .map((line) => `- ${line.at ?? ""} ${line.message ?? ""}`.trim())
    .join("\n");

  const sections = [
    `**Source:** ${report.source}`,
    `**Instance:** ${report.instance}`,
    `**When:** ${report.at}`,
    `**System:** ${report.sysInfo.platform}/${report.sysInfo.arch} node ${report.sysInfo.nodeVersion}` +
      (report.sysInfo.giniCommit ? ` commit ${report.sysInfo.giniCommit}` : ""),
    "",
    `**Error:** ${redact(report.error.name)}: ${redact(report.error.message)}`,
    "",
    "```",
    redact(report.error.stack),
    "```",
    "",
    "**Recent events:**",
    logLines ? redact(logLines) : "_none_",
    "",
    fingerprintMarker(report.fingerprint)
  ];
  const title = `[crash] ${report.source}: ${truncate(redact(report.error.name))}: ${truncate(redact(report.error.message))}`;
  return { title, body: sections.join("\n") };
}

export async function reportCrash(ctx: CliContext, deps: ReportCrashDeps = {}): Promise<void> {
  const supervisorImpl = deps.supervisorImpl ?? supervisor;
  // Gate: only launchd/autostart instances file (decision 3).
  if (supervisorImpl() !== "launchd") return;

  const reportPath = flagValue(ctx.cliArgs, "--report") ?? flagValue(ctx.rawArgs, "--report");
  if (!reportPath || !existsSync(reportPath)) return;

  let report: CrashReport;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as CrashReport;
  } catch {
    return;
  }
  if (!report.fingerprint) return;
  const instance = report.instance || ctx.config.instance;

  const gh = deps.gh ?? defaultGhRunner;
  const clock = deps.clock ?? (() => new Date());

  // gh unauthenticated: leave a local breadcrumb and exit cleanly. Never block.
  if (!isGhAuthed(gh)) {
    appendLog(instance, "crash.report.skipped", { reason: "gh-unauthed", fingerprint: report.fingerprint });
    return;
  }

  const state = readRateLimitState(report.fingerprint);
  const nowMs = clock().getTime();
  const nowIso = clock().toISOString();

  ensureCrashLabel(gh);

  // Crash-loop safety. GitHub's issue search is indexed asynchronously, so a
  // just-created issue may not be findable on the next crash a second later.
  // To avoid filing a duplicate during a tight loop we:
  //   1. If we already know the issue number for this fingerprint, comment
  //      straight on it (rate-limited) and never search.
  //   2. Otherwise search, and distinguish "absent" from a lookup "error":
  //      only create on a confirmed "absent", and only when we haven't just
  //      filed (lastFiledAt outside the comment interval) — that guards
  //      against a create-storm while the first issue is still un-indexed. A
  //      lookup error with a recent filing is skipped rather than risk a dup.
  if (typeof state.issueNumber === "number") {
    commentOrSuppress(gh, report, instance, state, state.issueNumber, nowMs, nowIso);
    return;
  }

  const found = findOpenIssueByFingerprint(gh, report.fingerprint);

  if (found.status === "found") {
    commentOrSuppress(gh, report, instance, state, found.number, nowMs, nowIso);
    return;
  }

  // Both "absent" and "error" must not create when we filed recently — the
  // existing issue is likely just not indexed yet. "error" additionally means
  // we couldn't even confirm absence, so the recent-filing guard is the only
  // thing keeping a crash loop from spraying duplicates.
  const filedRecently = state.lastFiledAt
    ? (() => {
        const filedMs = new Date(state.lastFiledAt).getTime();
        return Number.isFinite(filedMs) && nowMs - filedMs < COMMENT_MIN_INTERVAL_MS;
      })()
    : false;

  if (filedRecently) {
    appendLog(instance, "crash.report.suppressed", {
      reason: found.status === "error" ? "lookup-error-recent-filing" : "create-suppressed-recent-filing",
      fingerprint: report.fingerprint
    });
    return;
  }
  if (found.status === "error") {
    // No recent filing, but we genuinely don't know if an issue exists. Skip
    // rather than risk a duplicate — a later tick will retry the lookup.
    appendLog(instance, "crash.report.skipped", { reason: "lookup-error", fingerprint: report.fingerprint });
    return;
  }

  // Confirmed absent and no recent filing — create a fresh issue.
  const { title, body } = buildIssueContent(report, instance);
  const created = createCrashIssue(gh, { title, body });
  if (created !== null) {
    writeRateLimitState(report.fingerprint, {
      lastFiledAt: nowIso,
      lastCommentAt: null,
      commentCount: 0,
      issueNumber: created
    });
    appendLog(instance, "crash.report.filed", { fingerprint: report.fingerprint, issue: created });
  }
}

// Comment on a known open issue, honoring the rate-limit budget (hard cap +
// minimum interval between comments). Persists the issue number so future
// recurrences skip the search entirely.
function commentOrSuppress(
  gh: GhRunner,
  report: CrashReport,
  instance: string,
  state: RateLimitState,
  issueNumber: number,
  nowMs: number,
  nowIso: string
): void {
  if (state.commentCount >= COMMENT_HARD_CAP) {
    appendLog(instance, "crash.report.suppressed", { reason: "comment-cap", fingerprint: report.fingerprint });
    return;
  }
  if (state.lastCommentAt) {
    const lastMs = new Date(state.lastCommentAt).getTime();
    if (Number.isFinite(lastMs) && nowMs - lastMs < COMMENT_MIN_INTERVAL_MS) {
      appendLog(instance, "crash.report.suppressed", { reason: "rate-limit", fingerprint: report.fingerprint });
      return;
    }
  }

  const { body } = buildIssueContent(report, instance);
  const commented = commentOnIssue(gh, issueNumber, body);
  if (commented) {
    writeRateLimitState(report.fingerprint, {
      lastFiledAt: state.lastFiledAt,
      lastCommentAt: nowIso,
      commentCount: state.commentCount + 1,
      issueNumber
    });
    appendLog(instance, "crash.report.commented", { fingerprint: report.fingerprint, issue: issueNumber });
  }
}
