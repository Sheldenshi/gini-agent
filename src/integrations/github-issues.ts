// Thin gh-CLI wrapper for filing deduped crash issues.
//
// All gh shellouts go through an injectable GhRunner so the report-crash
// command and its tests never depend on a live `gh` binary or network. The
// default runner is spawnSync("gh", ...). Functions here own the gh argument
// shapes (label create, issue list/search, issue create/comment) and the
// hidden-marker dedup match — the command module (src/cli/commands/report-crash.ts)
// owns the policy (gate, rate-limit, build vs comment).

import { spawnSync } from "node:child_process";

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface GhRunner {
  run(args: string[], opts?: { input?: string }): GhResult;
}

export const CRASH_LABEL = "gini-crash";

// Default runner: real `gh` via spawnSync. `input` is piped to stdin so we can
// pass long issue bodies via `--body-file -` without shell-quoting hazards.
export const defaultGhRunner: GhRunner = {
  run(args, opts) {
    const res = spawnSync("gh", args, { encoding: "utf8", input: opts?.input });
    return {
      ok: res.status === 0,
      stdout: (res.stdout ?? "").toString(),
      stderr: (res.stderr ?? "").toString(),
      status: res.status ?? null
    };
  }
};

// Returns true when gh reports an authenticated account. Injectable via the
// runner so tests don't probe the real keychain.
export function isGhAuthed(gh: GhRunner): boolean {
  return gh.run(["auth", "status"]).ok;
}

// Idempotently create the `gini-crash` label. gh exits non-zero with an
// "already exists" message when the label is present; treat that as success.
export function ensureCrashLabel(gh: GhRunner): void {
  const res = gh.run([
    "label", "create", CRASH_LABEL,
    "--color", "B60205",
    "--description", "Automatically filed Gini crash report"
  ]);
  if (res.ok) return;
  if (/already exists/i.test(res.stderr) || /already exists/i.test(res.stdout)) return;
  // Any other failure is non-fatal — the issue create/comment still works
  // without the label. The command module logs; we don't throw here.
}

// The hidden marker embedded in every crash issue body so recurrences of the
// same fingerprint find and reuse the existing open issue.
export function fingerprintMarker(fingerprint: string): string {
  return `<!-- gini-crash-fingerprint: ${fingerprint} -->`;
}

// Outcome of a fingerprint lookup. We MUST distinguish a genuine "no open
// issue" from a lookup error: collapsing both to null lets a crash loop create
// a duplicate issue every time `gh issue list` transiently fails. The caller
// only creates on "absent"; on "error" it suppresses to avoid duplicates.
export type FindIssueResult =
  | { status: "found"; number: number }
  | { status: "absent" }
  | { status: "error" };

// Find an OPEN crash issue carrying this fingerprint's hidden marker. The
// search narrows the candidate set; we still confirm the exact marker in each
// returned body (gh search is fuzzy and could match a marker substring).
export function findOpenIssueByFingerprint(gh: GhRunner, fingerprint: string): FindIssueResult {
  const marker = fingerprintMarker(fingerprint);
  const res = gh.run([
    "issue", "list",
    "--label", CRASH_LABEL,
    "--state", "open",
    "--search", marker,
    "--json", "number,body"
  ]);
  // A failed lookup is NOT "absent" — we don't know whether an issue exists,
  // so the caller must not create one off the back of it.
  if (!res.ok) return { status: "error" };
  let parsed: Array<{ number?: number; body?: string }>;
  try {
    parsed = JSON.parse(res.stdout) as Array<{ number?: number; body?: string }>;
  } catch {
    return { status: "error" };
  }
  for (const issue of parsed) {
    if (typeof issue.number === "number" && typeof issue.body === "string" && issue.body.includes(marker)) {
      return { status: "found", number: issue.number };
    }
  }
  return { status: "absent" };
}

// Create a new crash issue. Body is piped via stdin (`--body-file -`) so it
// can carry newlines and the hidden marker without shell quoting. Returns the
// new issue number when gh prints a parseable issue URL, else null.
export function createCrashIssue(gh: GhRunner, args: { title: string; body: string }): number | null {
  const res = gh.run([
    "issue", "create",
    "--label", CRASH_LABEL,
    "--title", args.title,
    "--body-file", "-"
  ], { input: args.body });
  if (!res.ok) return null;
  const match = res.stdout.match(/\/issues\/(\d+)/);
  return match && match[1] ? Number(match[1]) : null;
}

export function commentOnIssue(gh: GhRunner, issueNumber: number, body: string): boolean {
  const res = gh.run([
    "issue", "comment", String(issueNumber),
    "--body-file", "-"
  ], { input: body });
  return res.ok;
}
