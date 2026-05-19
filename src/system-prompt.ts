// Authoritative agent system prompt + memory assembly.
//
// Lives outside provider.ts because the prompt is content (agent identity),
// not transport (LLM I/O). Both the legacy single-shot path in provider.ts
// and the chat-task agent loop in execution/ pull from here so they ship
// the same instructions to the model.

import type { JobRecord, MemoryRecord } from "./types";

const INSTRUCTIONS = [
  "You are Gini, a local-first personal agent.",
  "Reply directly and concisely.",
  "When the user asks for an action you have a tool for, execute it; do not narrate what you would do.",
  "Keep working until the task is done or you are genuinely blocked (waiting on approval, missing input, or a tool failure).",
  "Do not claim to have performed side effects. Risky side effects are handled by tools and approvals.",
  "When the user asks for a change to existing state, plan to the target end state — including cleanup of obsolete state — then execute the full plan before replying.",
  "Describe what you actually did at the tool level (\"deleted job X and created job Y\"), not the user's intent verb. Only report blocked after confirming no composition of available tools reaches the target state.",
  "When the user refers to \"this job\", \"my reminder\", or any existing scheduled job, call list_jobs first to find the right jobId before update_job or delete_job."
].join("\n");

// Assemble the system-area context: base instructions + pinned memories +
// long-term recalled memory. Placing memory in the system channel (rather
// than the user message) gives it higher-priority placement without
// talking the model into believing it.
export function buildAgentSystemContext(memories: MemoryRecord[], recalledContext?: string): string {
  const parts = [INSTRUCTIONS];
  if (memories.length > 0) {
    const pinned = memories.map((memory) => `- ${memory.content}`).join("\n");
    parts.push(`Pinned memories about this user (curated, always relevant):\n${pinned}`);
  }
  if (recalledContext && recalledContext.trim().length > 0) {
    parts.push(`Long-term memory of prior conversations with this user (use these facts when answering):\n${recalledContext}`);
  }
  return parts.join("\n\n");
}

// Build a "Bound scheduled jobs" block describing which jobs are attached to
// the current chat session. The chat-task loop scans `state.jobs` for any
// record whose `chatSessionId` matches the session backing the current task
// and passes the matching records here. We present the records as data and
// let the model infer relevance from conversational cues — explicit
// "if the user says 'this job'…" directives in the system prompt collided
// with the base list_jobs guidance and added more noise than they were
// worth.
//
// Returns an empty string when no jobs are bound — the caller can guard
// against stray whitespace by checking the empty case before appending.
export function buildBoundJobsBlock(jobs: JobRecord[]): string {
  if (jobs.length === 0) return "";
  const intro = jobs.length === 1
    ? "This chat session is bound to the scheduled job listed below."
    : `This chat session is bound to the ${jobs.length} scheduled jobs listed below.`;
  const entries = jobs.map((job) => {
    const lines: string[] = [];
    lines.push(`- id: ${job.id}`);
    lines.push(`  name: ${job.name}`);
    lines.push(`  schedule: ${describeJobSchedule(job)}`);
    // Prompts are user-authored content, not untrusted external data, so we
    // include the full text. The model needs it to reason about edits like
    // "change the topic from X to Y" or "make it remind me about Z instead".
    appendPromptLines(lines, job.prompt);
    return lines.join("\n");
  });
  return [`Bound scheduled jobs:`, intro, ...entries].join("\n");
}

function describeJobSchedule(job: JobRecord): string {
  if (job.cronExpression) {
    const tz = job.cronTimezone ?? "UTC";
    return `cron \`${job.cronExpression}\` (${tz})`;
  }
  if (typeof job.intervalSeconds === "number") {
    return `every ${job.intervalSeconds}s`;
  }
  return "(no schedule)";
}

// Render the job's prompt onto `lines`. Single-line prompts (and the empty
// placeholder) sit inline after `prompt:`; multi-line prompts break onto
// their own indented block under a bare `prompt:` label so the inline
// branch never leaves a trailing space after the colon.
function appendPromptLines(lines: string[], prompt: string): void {
  if (!prompt) {
    lines.push(`  prompt: (empty)`);
    return;
  }
  if (!prompt.includes("\n")) {
    lines.push(`  prompt: ${prompt}`);
    return;
  }
  lines.push(`  prompt:`);
  for (const promptLine of prompt.split("\n")) {
    lines.push(`    ${promptLine}`);
  }
}
