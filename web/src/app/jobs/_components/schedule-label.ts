import type { JobRecord } from "@runtime/types";

// Shared "how is this job scheduled?" label used by JobList rows and the
// JobDetail header. Two display modes:
//   - cron-driven:  `0 9 * * * (America/Los_Angeles)`
//   - interval:     `every 60s`
// Both are terse (these render inside font-mono 11px metadata lines next to
// the job id). The helper is the single source of truth so the list and
// detail can't drift out of sync.
export function scheduleLabel(job: JobRecord): string {
  if (job.cronExpression) {
    const tz = job.cronTimezone ?? "UTC";
    return `${job.cronExpression} (${tz})`;
  }
  return `every ${job.intervalSeconds}s`;
}
