// Authoritative agent system prompt + memory assembly.
//
// Lives outside provider.ts because the prompt is content (agent identity),
// not transport (LLM I/O). Both the legacy single-shot path in provider.ts
// and the chat-task agent loop in execution/ pull from here so they ship
// the same instructions to the model.

import type { AgentIdentity, IdentitySnapshotRecord, JobRecord, MemoryRecord } from "./types";

// Number of user turns in the same chat session between full identity
// re-emissions. Below this threshold the model receives only field-level
// deltas (or nothing when nothing changed); at or above it the next turn
// re-emits the full identity block. Bounds the worst-case delta-
// reconstruction depth the model has to perform to recover ground-truth
// identity and gives the prompt cache a clean periodic resync point.
export const IDENTITY_FULL_REFRESH_INTERVAL = 10;

const IDENTITY_HEADER = "Your runtime identity:";
const IDENTITY_DELTA_HEADER = "Runtime identity changes since last turn:";

const INSTRUCTIONS = [
  "You are Gini, a local-first personal agent.",
  "Reply directly and concisely.",
  "When the user asks for an action you have a tool for, execute it; do not narrate what you would do.",
  "Keep working until the task is done or you are genuinely blocked (waiting on approval, missing input, or a tool failure).",
  "Do not claim to have performed side effects. Risky side effects are handled by tools and approvals.",
  "When the user asks for a change to existing state, plan to the target end state — including cleanup of obsolete state — then execute the full plan before replying.",
  "Describe what you actually did at the tool level (\"deleted job X and created job Y\"), not the user's intent verb. Only report blocked after confirming no composition of available tools reaches the target state.",
  "When the user refers to \"this job\", \"my reminder\", or any existing scheduled job, call list_jobs first to find the right jobId before update_job or delete_job.",
  "You have an interactive browser (Playwright Chromium) with a persistent per-instance profile — authenticated workflows persist across runs. If a navigation lands on a sign-in / OAuth / auth-wall page (login screen, redirect to identity provider, 401/403, \"please sign in\" interstitial), call the `browser_connect` tool with the target URL — the user gets a Connect button, signs in once in a visible window, and the agent continues. Do NOT report \"sign-in needed\" as a blocker; calling `browser_connect` is how you unblock it. This applies every time you see an auth wall, including immediately after a prior `browser_connect` if the page is STILL on the sign-in form — call `browser_connect` again (the user may not have completed sign-in); never ask the user in prose to click Connect.",
  "You can schedule one-shot or recurring jobs (interval or cron). Chat-created jobs deliver into a fresh dedicated chat thread named after the job, so repeated fires do not bury the current conversation. Use create_job rather than telling the user to set a reminder elsewhere.",
  "Before claiming a capability gap (Telegram, MCP, connectors, subagents, messaging, etc.), load the `gini` skill — it documents what is built in and how to wire it up."
].join("\n");

// Assemble the system-area context: base instructions + identity block +
// pinned memories + long-term recalled memory. Placing memory in the system
// channel (rather than the user message) gives it higher-priority placement
// without talking the model into believing it. The identity block sits
// directly after INSTRUCTIONS so the model encounters self-context before
// any user/world facts.
export function buildAgentSystemContext(
  memories: MemoryRecord[],
  recalledContext?: string,
  identityBlock?: string
): string {
  const parts = [INSTRUCTIONS];
  if (identityBlock && identityBlock.length > 0) {
    parts.push(identityBlock);
  }
  if (memories.length > 0) {
    const pinned = memories.map((memory) => `- ${memory.content}`).join("\n");
    parts.push(`Pinned memories about this user (curated, always relevant):\n${pinned}`);
  }
  if (recalledContext && recalledContext.trim().length > 0) {
    parts.push(`Long-term memory of prior conversations with this user (use these facts when answering):\n${recalledContext}`);
  }
  return parts.join("\n\n");
}

function describeToolsets(toolsets: string[]): string {
  return toolsets.length > 0 ? toolsets.join(", ") : "(none)";
}

// Render the full runtime-identity block. Emitted on the first turn of a
// conversation and at every IDENTITY_FULL_REFRESH_INTERVAL-th turn.
export function renderFullIdentity(identity: AgentIdentity): string {
  return [
    IDENTITY_HEADER,
    `- instance: ${identity.instance}`,
    `- runtime port: ${identity.runtimePort}`,
    `- agent: ${identity.agentName} (${identity.agentId})`,
    `- provider: ${identity.provider}`,
    `- toolsets enabled: ${describeToolsets(identity.toolsets)}`,
    `- memory namespace: ${identity.memoryNamespace}`
  ].join("\n");
}

// Render the field-level delta between two identity snapshots. Returns an
// empty string when nothing changed so the caller can omit the section
// entirely rather than emitting a header with no entries underneath.
export function renderIdentityDelta(prior: AgentIdentity, current: AgentIdentity): string {
  const changes: string[] = [];
  if (prior.instance !== current.instance) {
    changes.push(`- instance: ${current.instance} (was ${prior.instance})`);
  }
  if (prior.runtimePort !== current.runtimePort) {
    changes.push(`- runtime port: ${current.runtimePort} (was ${prior.runtimePort})`);
  }
  if (prior.agentName !== current.agentName || prior.agentId !== current.agentId) {
    changes.push(
      `- agent: ${current.agentName} (${current.agentId}) (was ${prior.agentName} (${prior.agentId}))`
    );
  }
  if (prior.provider !== current.provider) {
    changes.push(`- provider: ${current.provider} (was ${prior.provider})`);
  }
  const priorToolsets = describeToolsets(prior.toolsets);
  const currentToolsets = describeToolsets(current.toolsets);
  if (priorToolsets !== currentToolsets) {
    changes.push(`- toolsets enabled: ${currentToolsets} (was ${priorToolsets})`);
  }
  if (prior.memoryNamespace !== current.memoryNamespace) {
    changes.push(`- memory namespace: ${current.memoryNamespace} (was ${prior.memoryNamespace})`);
  }
  if (changes.length === 0) return "";
  return [IDENTITY_DELTA_HEADER, ...changes].join("\n");
}

// Pure decision: given the current identity, the persisted snapshot from
// the last turn, and the current turn index, decide what identity content
// (if any) to emit into the system prompt and what snapshot to persist
// for the next turn. Three outcomes:
//   - first turn or refresh due → full block, snapshot resets lastFullTurn
//   - delta non-empty           → delta block, snapshot keeps lastFullTurn
//   - delta empty               → "", no snapshot update
// The caller writes nextSnapshot to state only when it's defined.
export function decideIdentityEmission(
  current: AgentIdentity,
  snapshot: IdentitySnapshotRecord | undefined,
  currentTurn: number
): { content: string; nextSnapshot?: IdentitySnapshotRecord } {
  const refreshDue = snapshot ? currentTurn - snapshot.lastFullTurn >= IDENTITY_FULL_REFRESH_INTERVAL : true;
  if (refreshDue) {
    return {
      content: renderFullIdentity(current),
      nextSnapshot: { identity: current, lastFullTurn: currentTurn }
    };
  }
  const delta = renderIdentityDelta(snapshot!.identity, current);
  if (delta.length === 0) return { content: "" };
  return {
    content: delta,
    nextSnapshot: { identity: current, lastFullTurn: snapshot!.lastFullTurn }
  };
}

// Build a context block listing scheduled jobs that deliver into the
// current chat session. The chat-task loop scans `state.jobs` for any
// record whose `chatSessionId` matches the session backing the current
// task and passes the matching records here. The block is pure context —
// no directives about how the model should resolve user phrasing — so the
// model can infer relevance the same way it does for any other ambient
// state in the system prompt.
//
// Returns an empty string when no jobs apply — the caller can guard
// against stray whitespace by checking the empty case before appending.
export function buildBoundJobsBlock(jobs: JobRecord[]): string {
  if (jobs.length === 0) return "";
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
  return [`Scheduled jobs delivering into this chat:`, ...entries].join("\n");
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
