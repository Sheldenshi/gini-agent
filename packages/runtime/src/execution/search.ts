import type { RuntimeConfig, SessionSearchResult } from "../types";
import { readState, readTrace } from "../state";

export function searchSessions(config: RuntimeConfig, query: string, limit = 20): SessionSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const state = readState(config.instance);
  const results: SessionSearchResult[] = [];

  for (const task of state.tasks) {
    addMatch(results, {
      id: task.id,
      instance: task.instance,
      kind: "task",
      title: task.title,
      excerpt: [task.input, task.summary, task.error].filter(Boolean).join("\n"),
      taskId: task.id,
      source: `task:${task.id}`,
      at: task.updatedAt
    }, needle);

    for (const trace of readTrace(config.instance, task.id)) {
      addMatch(results, {
        id: trace.id,
        instance: trace.instance,
        kind: "trace",
        title: trace.message,
        excerpt: `${trace.message}\n${JSON.stringify(trace.data ?? {})}`,
        taskId: task.id,
        traceId: trace.id,
        source: `trace:${task.id}:${trace.id}`,
        at: trace.at
      }, needle);
    }
  }

  // The `state.memories` source was removed alongside the state.memories
  // consolidation; identity facts live in USER.md and recalled-from-
  // Hindsight memory now. Cross-session lookups against Hindsight units
  // happen via `recall_memory` / `/api/memory/recall`. See ADR
  // runtime-identity-files.md.

  for (const skill of state.skills) {
    addMatch(results, {
      id: skill.id,
      instance: skill.instance,
      kind: "skill",
      title: skill.name,
      excerpt: `${skill.description}\n${skill.trigger}\n${skill.steps.join("\n")}`,
      source: `skill:${skill.id}`,
      at: skill.updatedAt
    }, needle);
  }

  for (const audit of state.audit) {
    addMatch(results, {
      id: audit.id,
      instance: audit.instance,
      kind: "audit",
      title: audit.action,
      excerpt: `${audit.action} ${audit.target} ${JSON.stringify(audit.evidence ?? {})}`,
      taskId: audit.taskId,
      source: `audit:${audit.id}`,
      at: audit.at
    }, needle);
  }

  return results
    .sort((a, b) => b.score - a.score || b.at.localeCompare(a.at))
    .slice(0, Math.max(1, limit));
}

function addMatch(results: SessionSearchResult[], candidate: Omit<SessionSearchResult, "score">, needle: string): void {
  const haystack = `${candidate.title}\n${candidate.excerpt}`.toLowerCase();
  if (!haystack.includes(needle)) return;
  const titleHit = candidate.title.toLowerCase().includes(needle) ? 5 : 0;
  const occurrenceScore = haystack.split(needle).length - 1;
  results.push({
    ...candidate,
    score: titleHit + occurrenceScore,
    excerpt: excerpt(candidate.excerpt, needle)
  });
}

function excerpt(value: string, needle: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const index = normalized.toLowerCase().indexOf(needle);
  if (index < 0) return normalized.slice(0, 240);
  return normalized.slice(Math.max(0, index - 80), index + needle.length + 160);
}
