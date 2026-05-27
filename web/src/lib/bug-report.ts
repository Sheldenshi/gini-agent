// Pure helpers for the in-app "Report a bug" flow. The dialog collects a
// short description plus a few optional fields, attaches whatever runtime
// diagnostic info is on hand (package version, git sha, instance), then
// shells out to GitHub's prefilled new-issue URL. Keeping the URL/body
// builders here as plain functions makes them trivial to unit test without
// dragging in React Testing Library.

const REPO_ISSUE_URL = "https://github.com/Lilac-Labs/gini-agent/issues/new";

export interface BugReportInput {
  title: string;
  whatHappened: string;
  stepsToReproduce: string;
  expected: string;
}

export interface BugReportContext {
  packageVersion?: string;
  gitShortSha?: string | null;
  gitBranch?: string | null;
  instance?: string;
  page?: string;
  userAgent?: string;
  reportedAt?: string;
}

export const DEFAULT_TITLE = "Bug report";
const NOT_PROVIDED = "_Not provided_";

function trimOrNotProvided(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : NOT_PROVIDED;
}

export function formatIssueTitle(input: Pick<BugReportInput, "title">): string {
  const trimmed = input.title.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_TITLE;
}

function formatDiagnostics(ctx: BugReportContext): string {
  const rows: string[] = [];
  if (ctx.packageVersion) rows.push(`- Version: \`${ctx.packageVersion}\``);
  const sha = ctx.gitShortSha?.trim();
  const branch = ctx.gitBranch?.trim();
  if (sha && branch) rows.push(`- Commit: \`${sha}\` (branch \`${branch}\`)`);
  else if (sha) rows.push(`- Commit: \`${sha}\``);
  else if (branch) rows.push(`- Branch: \`${branch}\``);
  if (ctx.instance) rows.push(`- Instance: \`${ctx.instance}\``);
  if (ctx.page) rows.push(`- Page: \`${ctx.page}\``);
  if (ctx.userAgent) rows.push(`- User agent: \`${ctx.userAgent}\``);
  if (ctx.reportedAt) rows.push(`- Reported: ${ctx.reportedAt}`);
  if (rows.length === 0) return "_No diagnostic info captured._";
  return rows.join("\n");
}

export function formatIssueBody(input: BugReportInput, ctx: BugReportContext): string {
  return [
    "### What happened?",
    trimOrNotProvided(input.whatHappened),
    "",
    "### Steps to reproduce",
    trimOrNotProvided(input.stepsToReproduce),
    "",
    "### Expected behavior",
    trimOrNotProvided(input.expected),
    "",
    "### Diagnostic info",
    formatDiagnostics(ctx),
    "",
    "<sub>Reported from the Gini in-app bug reporter.</sub>"
  ].join("\n");
}

// Reference the existing issue template instead of asserting the `bug`
// label directly: GitHub's `labels` query parameter requires the
// reporter to have push/triage permission on the repo and otherwise
// 404s, which would break the in-app reporter for any external user.
// Pointing at the template applies its front-matter labels (see
// .github/ISSUE_TEMPLATE/bug_report.md) without that permission gate.
// We still send `body` so GitHub uses our prefilled content rather than
// the template's section scaffolding.
export function buildIssueUrl(input: BugReportInput, ctx: BugReportContext): string {
  const params = new URLSearchParams();
  params.set("title", formatIssueTitle(input));
  params.set("body", formatIssueBody(input, ctx));
  params.set("template", "bug_report.md");
  return `${REPO_ISSUE_URL}?${params.toString()}`;
}

export function isReportSubmittable(input: BugReportInput): boolean {
  return input.whatHappened.trim().length > 0;
}
