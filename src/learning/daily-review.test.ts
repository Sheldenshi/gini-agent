// Daily review (ADR skill-learning-from-outcomes.md): the dedicated "Skill
// review" channel is provisioned once (idempotent), feedback candidates are
// sampled + marked prompted, and a digest is posted only when there's
// something to say.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { addAudit, listChatBlocks, mutateState, readState } from "../state";
import { proposeImprovement } from "../governance/improvements";
import { recordObjectiveOutcomes } from "./outcomes";
import { ensureSkillReviewSession, runDailyReview } from "./daily-review";
import type { RuntimeConfig, Task } from "../types";

const ROOT = "/tmp/gini-daily-review-test";

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

// Produce a realistic tier-2 feedback candidate the way recordObjectiveOutcomes
// does in production: a consequential side-effecting completion with no skill
// script -> one unattributed success that is consequential && !selfVerifiable.
async function recordConsequentialCompletion(
  config: RuntimeConfig,
  instance: string,
  taskId: string
): Promise<void> {
  await mutateState(instance, (state) => {
    addAudit(
      state,
      {
        actor: "agent",
        action: "messaging.sent",
        target: `thread_${taskId}`,
        risk: "medium",
        taskId
      },
      { taskId }
    );
  });
  await recordObjectiveOutcomes(config, makeTask(instance, taskId, "completed"));
}

describe("ensureSkillReviewSession", () => {
  test("provisions the channel once (idempotent)", async () => {
    const instance = "review-session";
    const config = makeConfig(instance);
    readState(instance);
    const first = await ensureSkillReviewSession(config);
    const second = await ensureSkillReviewSession(config);
    expect(first).toBe(second);
    const sessions = readState(instance).chatSessions.filter((s) => s.feature === "skill-review");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.kind).toBe("channel");
    expect(sessions[0]!.title).toBe("Skill review");
  });
});

describe("runDailyReview", () => {
  test("idle review posts nothing", async () => {
    const instance = "idle";
    const config = makeConfig(instance);
    readState(instance);
    const result = await runDailyReview(config);
    expect(result.posted).toBe(false);
    const session = readState(instance).chatSessions.find((s) => s.feature === "skill-review")!;
    expect(session.messageIds).toHaveLength(0);
  });

  test("samples feedback candidates, marks them prompted, and posts a digest", async () => {
    const instance = "feedback";
    const config = makeConfig(instance);
    readState(instance);
    // 4 consequential, unverifiable successes produced via the real production
    // path (recordObjectiveOutcomes) -> only 3 should be sampled.
    for (let i = 0; i < 4; i++) {
      await recordConsequentialCompletion(config, instance, `task_${i}`);
    }
    // Sanity: the production path really did produce sample-able rows.
    const candidates = readState(instance).skillOutcomes.filter(
      (o) => o.signal === "success" && o.consequential && !o.selfVerifiable
    );
    expect(candidates).toHaveLength(4);

    const result = await runDailyReview(config);
    expect(result.feedbackAsked).toBe(3);
    expect(result.posted).toBe(true);

    const state = readState(instance);
    const prompted = state.skillOutcomes.filter((o) => o.feedbackPrompted);
    expect(prompted).toHaveLength(3);
    const session = state.chatSessions.find((s) => s.feature === "skill-review")!;
    expect(session.messageIds.length).toBe(1);
    const message = state.chatMessages.find((m) => m.id === session.messageIds[0]);
    expect(message!.content).toContain("Quick questions about recent actions");
    // The digest must also emit a renderable assistant_text block — the chat UI
    // reads the /blocks stream, not the durable chatMessages transcript.
    const blocks = listChatBlocks(instance, session.id);
    expect(
      blocks.some(
        (b) => b.kind === "assistant_text" && b.text.includes("Quick questions about recent actions")
      )
    ).toBe(true);
  });

  test("a standing proposal is not re-posted on the next run", async () => {
    const instance = "no-respam";
    const config = makeConfig(instance);
    readState(instance);
    // A pending skill-edit proposal that stays unactioned across two runs.
    await proposeImprovement(config, {
      kind: "skill",
      title: "Improve skill: payer",
      rationale: "Recurring failures.",
      payload: {
        mode: "edit",
        targetSkillId: "skill_x",
        baseBody: "# Payer\n",
        edits: [{ op: "append", content: "Confirm." }]
      }
    });

    const first = await runDailyReview(config);
    expect(first.posted).toBe(true);
    let session = readState(instance).chatSessions.find((s) => s.feature === "skill-review")!;
    expect(session.messageIds).toHaveLength(1);
    // The watermark advanced.
    expect(readState(instance).lastSkillReviewDigestAt).toBeDefined();

    // Second run: the same proposal is still standing, nothing new -> no post.
    const second = await runDailyReview(config);
    expect(second.posted).toBe(false);
    session = readState(instance).chatSessions.find((s) => s.feature === "skill-review")!;
    expect(session.messageIds).toHaveLength(1);
  });

  test("concurrent runs are single-flighted (only one posts)", async () => {
    const instance = "single-flight";
    const config = makeConfig(instance);
    readState(instance);
    await recordConsequentialCompletion(config, instance, "task_sf");

    const [a, b] = await Promise.all([runDailyReview(config), runDailyReview(config)]);
    // Exactly one run did the work; the other returned early.
    const posted = [a, b].filter((r) => r.posted);
    expect(posted).toHaveLength(1);
    const session = readState(instance).chatSessions.find((s) => s.feature === "skill-review")!;
    expect(session.messageIds).toHaveLength(1);
  });
});
