// Daily skill-learning review (ADR skill-learning-from-outcomes.md, decision #2).
//
// runDailyReview: reflect over recent failures, sample up to 3 feedback
// questions (consequential successes the objective tier can't verify),
// assemble a digest, and post it into a dedicated, auto-provisioned
// "Skill review" chat session — NEVER the user's main chat. The session is a
// channel-kind session stamped feature:"skill-review", created once
// (idempotent). Hosted by a slow abortable loop in src/server.ts.

import type { ChatSessionRecord, RuntimeConfig, SkillOutcome } from "../types";
import { createChatMessage, createChatSession, insertChatBlock, mutateState, now, readState } from "../state";
import { reflectOnSkillOutcomes } from "./reflect";

const SKILL_REVIEW_TITLE = "Skill review";
const MAX_FEEDBACK_QUESTIONS = 3;

// In-process single-flight guard: the 24h loop and the manual
// POST /api/learning/review must not race into duplicate proposals/findings.
// Keyed by instance so distinct instances run independently.
const inFlight = new Set<string>();

export interface DailyReviewResult {
  proposalsCreated: number;
  findingsCreated: number;
  feedbackAsked: number;
  posted: boolean;
  sessionId: string;
}

// Ensure the dedicated "Skill review" channel exists, returning its id.
// Idempotent: keyed on feature:"skill-review", created once.
export async function ensureSkillReviewSession(config: RuntimeConfig): Promise<string> {
  const existing = findSkillReviewSession(readState(config.instance).chatSessions);
  if (existing) return existing.id;
  return mutateState(config.instance, (state) => {
    // Re-check under the lock so two callers can't both create one.
    const found = findSkillReviewSession(state.chatSessions);
    if (found) return found.id;
    const agentId = state.activeAgentId;
    const created = createChatSession(state, SKILL_REVIEW_TITLE, undefined, agentId, "job", "channel");
    created.feature = "skill-review";
    return created.id;
  });
}

function findSkillReviewSession(sessions: ChatSessionRecord[]): ChatSessionRecord | undefined {
  return sessions.find((s) => s.feature === "skill-review");
}

export async function runDailyReview(config: RuntimeConfig): Promise<DailyReviewResult> {
  // Single-flight per instance: a concurrent run (the loop racing a manual
  // POST /api/learning/review) returns early rather than duplicating proposals.
  if (inFlight.has(config.instance)) {
    return {
      proposalsCreated: 0,
      findingsCreated: 0,
      feedbackAsked: 0,
      posted: false,
      sessionId: ""
    };
  }
  inFlight.add(config.instance);
  try {
    return await runDailyReviewInner(config);
  } finally {
    inFlight.delete(config.instance);
  }
}

async function runDailyReviewInner(config: RuntimeConfig): Promise<DailyReviewResult> {
  const reflect = await reflectOnSkillOutcomes(config);

  // Select up to 3 feedback candidates: recent consequential successes the
  // objective tier couldn't verify, not yet asked about. Mark them prompted so
  // a later review doesn't re-ask. selfVerifiable successes are skipped — the
  // objective signal already covered them.
  const feedback = await mutateState(config.instance, (state) => {
    const candidates = state.skillOutcomes
      .filter(
        // !selfVerifiable already implies consequential for a success row
        // (selfVerifiable = !consequential), so the consequential check is
        // redundant and is dropped. user_feedback rows are already prompted.
        (o) =>
          o.signal === "success" &&
          !o.selfVerifiable &&
          !o.feedbackPrompted &&
          o.source === "objective"
      )
      .slice(0, MAX_FEEDBACK_QUESTIONS);
    for (const c of candidates) c.feedbackPrompted = true;
    return candidates.map((c) => ({ ...c }));
  });

  const sessionId = await ensureSkillReviewSession(config);

  // Assemble the digest from the now-current state, but only re-surface
  // proposals/findings created AFTER the last digest so a standing
  // (still-unactioned) proposal isn't re-posted every run (decision #2 — the
  // digest doesn't spam). Feedback questions are intrinsically new (they
  // advance feedbackPrompted), so they're always included.
  const state = readState(config.instance);
  const since = state.lastSkillReviewDigestAt;
  const isNew = (createdAt: string) => since === undefined || createdAt > since;
  const openFindings = state.learningFindings.filter((f) => f.status === "open" && isNew(f.createdAt));
  const pendingProposals = state.improvements.filter(
    (p) => p.status === "proposed" && p.kind === "skill" && p.payload.mode === "edit" && isNew(p.createdAt)
  );

  // Nothing new to say -> don't post (keeps the channel quiet, no re-spam).
  if (pendingProposals.length === 0 && openFindings.length === 0 && feedback.length === 0) {
    return {
      proposalsCreated: reflect.proposalsCreated,
      findingsCreated: reflect.findingsCreated,
      feedbackAsked: 0,
      posted: false,
      sessionId
    };
  }

  const digest = buildDigest(pendingProposals, openFindings, feedback);
  await mutateState(config.instance, (s) => {
    createChatMessage(s, {
      sessionId,
      role: "assistant",
      content: digest
    });
    // Advance the digest watermark so the next run won't re-post these.
    s.lastSkillReviewDigestAt = now();
  });
  // The chat UI renders BLOCKS (the /blocks stream web + mobile read), not the
  // durable chatMessages transcript — so emit a renderable assistant_text block
  // too, or the digest persists invisibly. insertChatBlock self-manages its
  // SQLite savepoint, so it runs cleanly after the JSON-state mutation above.
  insertChatBlock(config.instance, {
    sessionId,
    kind: "assistant_text",
    text: digest,
    streaming: false
  });

  return {
    proposalsCreated: reflect.proposalsCreated,
    findingsCreated: reflect.findingsCreated,
    feedbackAsked: feedback.length,
    posted: true,
    sessionId
  };
}

function buildDigest(
  proposals: ReadonlyArray<{ id: string; title: string; rationale: string }>,
  findings: ReadonlyArray<{ kind: string; summary: string }>,
  feedback: SkillOutcome[]
): string {
  const lines: string[] = ["Skill review"];

  if (proposals.length > 0) {
    lines.push("", "Proposed skill edits (approve or reject):");
    for (const p of proposals) {
      lines.push(`- ${p.title} — ${p.rationale} (improvement ${p.id})`);
    }
  }

  if (findings.length > 0) {
    lines.push("", "Findings (no skill edit):");
    for (const f of findings) {
      lines.push(`- [${f.kind}] ${f.summary}`);
    }
  }

  if (feedback.length > 0) {
    lines.push("", "Quick questions about recent actions:");
    for (const o of feedback) {
      const label = o.skillName ?? "an action";
      lines.push(
        `- Did "${label}" (task ${o.taskId}) turn out right? If not, tell me what went wrong so I can fix the skill.`
      );
    }
  }

  return lines.join("\n");
}
