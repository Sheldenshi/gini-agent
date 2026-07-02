// Adversarial probes for the daily skill-learning review
// (ADR skill-learning-from-outcomes.md, decision #2).
//
// These tests TRY TO BREAK the no-respam watermark, the single-flight guard,
// the feedback-cap sampling, the idempotent channel provisioning, and the
// "the digest must be renderable, not just a transcript row" guarantee. Each
// test asserts the INTENDED behavior — a failure here is a likely real bug.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  addAudit,
  createSkillOutcome,
  listChatBlocks,
  mutateState,
  now,
  readState
} from "../state";
import { proposeImprovement } from "../governance/improvements";
import { createLearningFinding } from "../state/records";
import { recordObjectiveOutcomes } from "./outcomes";
import { ensureSkillReviewSession, runDailyReview } from "./daily-review";
import type { RuntimeConfig, Task } from "../types";

// Unique root containing the slice name so parallel probers don't collide.
const ROOT = "/tmp/gini-daily-review-probe-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

function makeTask(instance: string, id: string, status: Task["status"]): Task {
  const at = new Date().toISOString();
  return {
    id,
    title: "t",
    input: "t",
    status,
    instance,
    agentId: "agent_test",
    createdAt: at,
    updatedAt: at,
    tracePath: "",
    auditIds: [],
    approvalIds: [],
    skillIds: []
  };
}

// Mirror the production tier-2 candidate path: a consequential side-effecting
// completion with NO skill script -> one unattributed consequential success
// (consequential && !selfVerifiable && source:"objective" && !feedbackPrompted).
async function recordConsequentialCompletion(
  config: RuntimeConfig,
  instance: string,
  taskId: string,
  skillName?: string
): Promise<void> {
  await mutateState(instance, (state) => {
    addAudit(
      state,
      { actor: "agent", action: "messaging.sent", target: `thread_${taskId}`, risk: "medium", taskId },
      { taskId }
    );
  });
  await recordObjectiveOutcomes(config, makeTask(instance, taskId, "completed"));
  if (skillName) {
    // Tag the just-created candidate with a human-readable skill name so the
    // digest's question line is realistic.
    await mutateState(instance, (state) => {
      const row = state.skillOutcomes.find((o) => o.taskId === taskId && o.signal === "success");
      if (row) row.skillName = skillName;
    });
  }
}

async function proposeStandingSkillEdit(config: RuntimeConfig, title: string): Promise<string> {
  const p = await proposeImprovement(config, {
    kind: "skill",
    title,
    rationale: "Recurring failures.",
    payload: {
      mode: "edit",
      targetSkillId: "skill_x",
      baseBody: "# Payer\n",
      edits: [{ op: "append", content: "Confirm." }]
    }
  });
  return p.id;
}

function reviewSession(instance: string) {
  return readState(instance).chatSessions.find((s) => s.feature === "skill-review");
}

function digestBlocks(instance: string, sessionId: string) {
  return listChatBlocks(instance, sessionId).filter((b) => b.kind === "assistant_text");
}

describe("daily-review probe: idle quiet channel", () => {
  test("idle review posts nothing, no message AND no renderable block", async () => {
    const instance = "probe-idle";
    const config = makeConfig(instance);
    readState(instance);

    const result = await runDailyReview(config);
    expect(result.posted).toBe(false);
    expect(result.feedbackAsked).toBe(0);

    const session = reviewSession(instance)!;
    expect(session.messageIds).toHaveLength(0);
    // The channel must stay visually empty too — no orphan assistant_text block.
    expect(digestBlocks(instance, session.id)).toHaveLength(0);
    expect(readState(instance).lastSkillReviewDigestAt).toBeUndefined();
  });

  test("repeated idle runs never provision a second channel and never post", async () => {
    const instance = "probe-idle-repeat";
    const config = makeConfig(instance);
    readState(instance);

    for (let i = 0; i < 5; i++) {
      const r = await runDailyReview(config);
      expect(r.posted).toBe(false);
    }
    const sessions = readState(instance).chatSessions.filter((s) => s.feature === "skill-review");
    expect(sessions).toHaveLength(1);
  });
});

describe("daily-review probe: idempotent provisioning across full runs", () => {
  test("runDailyReview never creates a duplicate Skill review channel", async () => {
    const instance = "probe-one-channel";
    const config = makeConfig(instance);
    readState(instance);

    // A run that posts, a run that doesn't, a manual ensure — exactly one channel.
    await proposeStandingSkillEdit(config, "Improve skill: a");
    await runDailyReview(config); // posts
    await runDailyReview(config); // standing, no post
    await ensureSkillReviewSession(config);
    await runDailyReview(config); // still standing, no post

    const sessions = readState(instance).chatSessions.filter((s) => s.feature === "skill-review");
    expect(sessions).toHaveLength(1);
  });
});

describe("daily-review probe: no-respam watermark", () => {
  test("a standing proposal is not re-posted, but a NEW proposal IS", async () => {
    const instance = "probe-respam";
    const config = makeConfig(instance);
    readState(instance);

    await proposeStandingSkillEdit(config, "Improve skill: standing");
    const first = await runDailyReview(config);
    expect(first.posted).toBe(true);
    expect(digestBlocks(instance, reviewSession(instance)!.id)).toHaveLength(1);

    // No-op run: nothing new, the standing proposal must NOT re-post.
    const second = await runDailyReview(config);
    expect(second.posted).toBe(false);
    expect(digestBlocks(instance, reviewSession(instance)!.id)).toHaveLength(1);

    // A genuinely-new proposal arrives AFTER the watermark.
    await proposeStandingSkillEdit(config, "Improve skill: fresh");
    const third = await runDailyReview(config);
    expect(third.posted).toBe(true);
    // Exactly two digests now exist (no duplicate from the standing one).
    const blocks = digestBlocks(instance, reviewSession(instance)!.id);
    expect(blocks).toHaveLength(2);
    // The fresh digest references the NEW proposal and NOT the standing one.
    const latest = blocks[blocks.length - 1]!;
    expect(latest.text).toContain("Improve skill: fresh");
    expect(latest.text).not.toContain("Improve skill: standing");
  });

  test("an open finding is not re-posted, but a NEW finding IS", async () => {
    const instance = "probe-respam-finding";
    const config = makeConfig(instance);
    readState(instance);

    await mutateState(instance, (s) => {
      createLearningFinding(s, {
        kind: "credential",
        summary: "Gmail token expired — reconnect.",
        sourceTaskIds: ["task_a"]
      });
    });
    expect((await runDailyReview(config)).posted).toBe(true);
    expect((await runDailyReview(config)).posted).toBe(false);

    await mutateState(instance, (s) => {
      createLearningFinding(s, {
        kind: "environment",
        summary: "Calendar API flaking — retry policy.",
        sourceTaskIds: ["task_b"]
      });
    });
    const third = await runDailyReview(config);
    expect(third.posted).toBe(true);
    const latest = digestBlocks(instance, reviewSession(instance)!.id).at(-1)!;
    expect(latest.text).toContain("Calendar API flaking");
    expect(latest.text).not.toContain("Gmail token expired");
  });

  // BOUNDARY PROBE: the watermark uses STRICT `createdAt > since`. A proposal
  // created in the SAME millisecond the digest watermark is stamped is at risk
  // of being silently dropped forever — it is never "new" (==) and never
  // re-posted (no later run sees it as new). We force the collision by stamping
  // the watermark and the new proposal's createdAt to the EXACT same ISO ms.
  test("a proposal created at the exact watermark timestamp is still surfaced (not lost)", async () => {
    const instance = "probe-watermark-boundary";
    const config = makeConfig(instance);
    readState(instance);

    // First digest from a standing proposal advances the watermark.
    await proposeStandingSkillEdit(config, "Improve skill: standing");
    await runDailyReview(config);

    // Now simulate a proposal whose createdAt collides EXACTLY with the
    // watermark (e.g. both stamped in the same ms by now()).
    const collide = readState(instance).lastSkillReviewDigestAt!;
    const id = await proposeStandingSkillEdit(config, "Improve skill: collision");
    await mutateState(instance, (s) => {
      const p = s.improvements.find((x) => x.id === id)!;
      p.createdAt = collide; // exactly == watermark
    });

    const r = await runDailyReview(config);
    // The collision proposal is genuinely new work the operator must see; if the
    // strict `>` drops it, this run posts nothing and the proposal is invisible.
    expect(r.posted).toBe(true);
    const latest = digestBlocks(instance, reviewSession(instance)!.id).at(-1)!;
    expect(latest.text).toContain("Improve skill: collision");
  });
});

describe("daily-review probe: feedback sampling", () => {
  test("caps at 3, marks prompted, and a NEW success on a later run is still picked", async () => {
    const instance = "probe-feedback-cap";
    const config = makeConfig(instance);
    readState(instance);

    // 5 consequential unverifiable successes -> only 3 sampled this run.
    for (let i = 0; i < 5; i++) {
      await recordConsequentialCompletion(config, instance, `task_${i}`, `act-${i}`);
    }
    const first = await runDailyReview(config);
    expect(first.feedbackAsked).toBe(3);
    expect(first.posted).toBe(true);

    let st = readState(instance);
    expect(st.skillOutcomes.filter((o) => o.feedbackPrompted)).toHaveLength(3);
    // 2 candidates remain un-prompted (carried to the next run).
    const remaining = st.skillOutcomes.filter(
      (o) => o.signal === "success" && !o.selfVerifiable && !o.feedbackPrompted && o.source === "objective"
    );
    expect(remaining).toHaveLength(2);

    // A brand-new consequential success arrives, then a second run.
    await recordConsequentialCompletion(config, instance, "task_new", "act-new");
    const second = await runDailyReview(config);
    // The 2 carried-over + 1 new = 3 still-unprompted -> capped at 3.
    expect(second.feedbackAsked).toBe(3);
    expect(second.posted).toBe(true);

    st = readState(instance);
    // 3 + 3 = 6 prompted now; no row double-asked.
    expect(st.skillOutcomes.filter((o) => o.feedbackPrompted)).toHaveLength(6);
    // The newest success was among those asked (it is now prompted).
    const fresh = st.skillOutcomes.find((o) => o.taskId === "task_new")!;
    expect(fresh.feedbackPrompted).toBe(true);
  });

  test("selfVerifiable successes are NEVER asked about (objective signal already covered them)", async () => {
    const instance = "probe-feedback-selfverifiable";
    const config = makeConfig(instance);
    readState(instance);

    // A self-verifiable success (e.g. a script that exited 0 on a non-consequential
    // skill) must not be sampled for human feedback.
    await mutateState(instance, (state) => {
      createSkillOutcome(state, {
        taskId: "task_sv",
        skillName: "lister",
        signal: "success",
        source: "objective",
        consequential: false,
        selfVerifiable: true,
        reviewed: false,
        feedbackPrompted: false
      });
    });
    const r = await runDailyReview(config);
    expect(r.feedbackAsked).toBe(0);
    expect(r.posted).toBe(false);
    expect(readState(instance).skillOutcomes.find((o) => o.taskId === "task_sv")!.feedbackPrompted).toBe(false);
  });

  test("user_feedback-source successes are not re-asked (already prompted)", async () => {
    const instance = "probe-feedback-source";
    const config = makeConfig(instance);
    readState(instance);

    // A success that came from a prior user_feedback answer is already prompted.
    await mutateState(instance, (state) => {
      createSkillOutcome(state, {
        taskId: "task_fb",
        skillName: "payer",
        signal: "success",
        source: "user_feedback",
        consequential: true,
        selfVerifiable: false,
        reviewed: false,
        feedbackPrompted: true
      });
    });
    const r = await runDailyReview(config);
    expect(r.feedbackAsked).toBe(0);
    expect(r.posted).toBe(false);
  });
});

describe("daily-review probe: renderable block parity", () => {
  test("every posted digest emits exactly one assistant_text block AND one chatMessage", async () => {
    const instance = "probe-block-parity";
    const config = makeConfig(instance);
    readState(instance);

    await recordConsequentialCompletion(config, instance, "task_p", "send-update");
    const r = await runDailyReview(config);
    expect(r.posted).toBe(true);

    const session = reviewSession(instance)!;
    // Exactly one durable transcript message.
    expect(session.messageIds).toHaveLength(1);
    const st = readState(instance);
    const message = st.chatMessages.find((m) => m.id === session.messageIds[0]);
    expect(message).toBeDefined();

    // Exactly one renderable block, and its text matches the durable message
    // (the UI reads /blocks, so a divergence means the operator sees the wrong
    // thing or nothing at all).
    const blocks = digestBlocks(instance, session.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("assistant_text");
    expect(blocks[0]!.streaming).toBe(false);
    expect(blocks[0]!.text).toBe(message!.content);
    expect(blocks[0]!.text).toContain("Quick questions about recent actions");
  });

  test("block count tracks post count across mixed posting/quiet runs (no invisible or duplicate digest)", async () => {
    const instance = "probe-block-count";
    const config = makeConfig(instance);
    readState(instance);

    // Run 1: a proposal -> posts.
    await proposeStandingSkillEdit(config, "Improve skill: one");
    expect((await runDailyReview(config)).posted).toBe(true);
    // Run 2: nothing new -> quiet.
    expect((await runDailyReview(config)).posted).toBe(false);
    // Run 3: a new finding -> posts.
    await mutateState(instance, (s) => {
      createLearningFinding(s, { kind: "model_ignored", summary: "Trigger unclear.", sourceTaskIds: ["t"] });
    });
    expect((await runDailyReview(config)).posted).toBe(true);

    const session = reviewSession(instance)!;
    // 2 posts -> 2 messages -> 2 blocks. One block per post, no orphans.
    expect(session.messageIds).toHaveLength(2);
    expect(digestBlocks(instance, session.id)).toHaveLength(2);
  });
});

describe("daily-review probe: concurrent single-flight", () => {
  test("two concurrent runs single-flight: one posts, one short-circuits, one block, one watermark", async () => {
    const instance = "probe-single-flight";
    const config = makeConfig(instance);
    readState(instance);
    await recordConsequentialCompletion(config, instance, "task_sf", "do-thing");

    const [a, b] = await Promise.all([runDailyReview(config), runDailyReview(config)]);
    const posted = [a, b].filter((r) => r.posted);
    const skipped = [a, b].filter((r) => !r.posted);
    expect(posted).toHaveLength(1);
    expect(skipped).toHaveLength(1);

    const session = reviewSession(instance)!;
    // Exactly one durable message and one renderable block — the loser produced
    // neither a duplicate digest nor an empty block.
    expect(session.messageIds).toHaveLength(1);
    expect(digestBlocks(instance, session.id)).toHaveLength(1);
    // Exactly one channel.
    expect(readState(instance).chatSessions.filter((s) => s.feature === "skill-review")).toHaveLength(1);
  });

  test("a concurrent run does not consume feedback candidates the winner couldn't ask", async () => {
    const instance = "probe-sf-feedback";
    const config = makeConfig(instance);
    readState(instance);
    // 3 candidates: a single winning run asks all 3. A losing concurrent run must
    // not mark any candidate prompted (it short-circuits before sampling).
    for (let i = 0; i < 3; i++) {
      await recordConsequentialCompletion(config, instance, `task_${i}`, `act-${i}`);
    }

    const [a, b] = await Promise.all([runDailyReview(config), runDailyReview(config)]);
    const asked = (a.posted ? a.feedbackAsked : 0) + (b.posted ? b.feedbackAsked : 0);
    expect(asked).toBe(3);
    // Exactly 3 prompted total — the loser did not also mark them.
    expect(readState(instance).skillOutcomes.filter((o) => o.feedbackPrompted)).toHaveLength(3);
  });

  test("sequential runs across distinct instances do not cross-block via the single-flight set", async () => {
    const instanceA = "probe-iso-a";
    const instanceB = "probe-iso-b";
    const configA = makeConfig(instanceA);
    const configB = makeConfig(instanceB);
    readState(instanceA);
    readState(instanceB);
    await proposeStandingSkillEdit(configA, "Improve skill: a");
    await proposeStandingSkillEdit(configB, "Improve skill: b");

    // Concurrent runs on DIFFERENT instances must each post (per-instance key).
    const [ra, rb] = await Promise.all([runDailyReview(configA), runDailyReview(configB)]);
    expect(ra.posted).toBe(true);
    expect(rb.posted).toBe(true);
    expect(digestBlocks(instanceA, reviewSession(instanceA)!.id)).toHaveLength(1);
    expect(digestBlocks(instanceB, reviewSession(instanceB)!.id)).toHaveLength(1);
  });
});
