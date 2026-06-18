// Regression tests for the per-turn AbortSignal (the #395 "full fix"):
// cancelTask aborts the in-flight model call at the source, so a turn cancelled
// mid-stream stops deterministically instead of running to the provider
// connection's natural end. Also covers the resume-path stuck-cursor finalize
// and the boot-time orphan heal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { cancelTask, submitTask } from "../agent";
import {
  closeAllMemoryDbs,
  createAuthorization,
  createChatSession,
  createTask,
  getMemoryDb,
  healOrphanedStreamingBlocks,
  insertChatBlock,
  isTerminalTaskStatus,
  listChatBlocks,
  mutateState,
  readState
} from "../state";
import { __turnSnapshot } from "./turn-abort";
import type { RuntimeConfig, TaskStatus } from "../types";

let scratchHome: string;
let prevHome: string | undefined;
let prevState: string | undefined;
let prevLog: string | undefined;
let prevEmbedding: string | undefined;
let root: string;
const workspaceDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "gini-abort-ws-"));
  workspaceDirs.push(dir);
  return dir;
}

// Unique instance name per call. getMemoryDb caches the SQLite handle by
// instance, and afterEach deletes the state root; a fixed name reused across
// runs (e.g. `bun test --rerun-each`) would reopen a stale cached handle
// pointing at a deleted file (SQLITE_IOERR_VNODE / "no such savepoint"). A
// fresh name per test never collides with a cached handle.
let instanceCounter = 0;
function uniqueInstance(base: string): string {
  instanceCounter += 1;
  return `${base}-${instanceCounter}`;
}

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-abort-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  root = mkdtempSync(join(tmpdir(), "gini-abort-"));
  prevState = process.env.GINI_STATE_ROOT;
  prevLog = process.env.GINI_LOG_ROOT;
  prevEmbedding = process.env.GINI_EMBEDDING_PROVIDER;
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
  clearEchoToolCallingResponses();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prevState;
  if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
  else process.env.GINI_LOG_ROOT = prevLog;
  if (prevEmbedding === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
  else process.env.GINI_EMBEDDING_PROVIDER = prevEmbedding;
  // Close cached SQLite handles before deleting the state root so a stale
  // handle can't outlive its file (the cache is keyed by instance name).
  closeAllMemoryDbs();
  rmSync(scratchHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  for (const dir of workspaceDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  clearEchoToolCallingResponses();
});

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? root,
    logRoot: process.env.GINI_LOG_ROOT ?? `${root}-logs`,
    approvalMode: "auto"
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("waitFor timed out");
}

describe("per-turn AbortSignal", () => {
  test("cancel aborts the in-flight model call at the source — the held call stops well before its full delay", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("abort-midcall"));
    const provider = normalizeProvider(config.provider);
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "abort-midcall", undefined, "agent_a")
    );

    // A model call held open for a LONG delay that would (if it ran to
    // completion) resolve to a tool call. The abort must cut it short.
    const LONG_DELAY = 4000;
    setEchoToolCallingResponse(
      {
        provider,
        text: "",
        toolCalls: [
          { id: "call_would_run", type: "function", function: { name: "get_current_time", arguments: "{}" } }
        ],
        finishReason: "tool_calls"
      },
      undefined,
      { delayMs: LONG_DELAY }
    );

    const task = await submitTask(config, "do a slow thing", { mode: "chat", chatSessionId: session.id });
    await waitFor(() => readState(config.instance).tasks.find((t) => t.id === task.id)?.status === "running");
    // The turn is registered in the abort registry while its model call is in
    // flight.
    await waitFor(() => __turnSnapshot(config.instance).some((e) => e.taskId === task.id));

    const cancelAt = Date.now();
    await cancelTask(config, task.id);
    // cancelTask flips status synchronously, so polling status is vacuous (it
    // would pass even if the held call kept spinning in the background). The
    // load-bearing observable is the turn-abort REGISTRY: runLoop releases its
    // entry only when the held model call actually returns/throws. With
    // source-level abort the held call rejects immediately, so the entry clears
    // well under the 4000ms delay. Without it, the entry lingers for the full
    // delay (verified: the test fails when the cancelTask→abort wiring is
    // reverted).
    await waitFor(() => !__turnSnapshot(config.instance).some((e) => e.taskId === task.id), LONG_DELAY - 500);
    const elapsed = Date.now() - cancelAt;
    expect(elapsed).toBeLessThan(LONG_DELAY - 1000);

    const finalStatus = readState(config.instance).tasks.find((t) => t.id === task.id)?.status;
    expect(finalStatus).toBe("cancelled");

    // The tool the held call would have produced must NEVER have been
    // dispatched — the model call was aborted before it returned the call.
    const blocks = listChatBlocks(config.instance, session.id);
    expect(blocks.some((b) => b.kind === "tool_call" && b.callId === "call_would_run")).toBe(false);
    // No assistant_text block left stuck streaming.
    expect(blocks.some((b) => b.kind === "assistant_text" && b.streaming)).toBe(false);
  });

  test("an aborted turn is cancelled, not failed, and records no provider auth failure", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("abort-not-failed"));
    const provider = normalizeProvider(config.provider);
    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "abort-not-failed", undefined, "agent_b")
    );
    setEchoToolCallingResponse(
      { provider, text: "I am answering slowly...", toolCalls: [], finishReason: "stop" },
      undefined,
      { delayMs: 3000 }
    );

    const task = await submitTask(config, "answer slowly", { mode: "chat", chatSessionId: session.id });
    await waitFor(() => readState(config.instance).tasks.find((t) => t.id === task.id)?.status === "running");
    await cancelTask(config, task.id);
    await waitFor(() => isTerminalTaskStatus(readState(config.instance).tasks.find((t) => t.id === task.id)?.status ?? "running"));

    const finished = readState(config.instance).tasks.find((t) => t.id === task.id);
    expect(finished?.status).toBe("cancelled");
    expect(finished?.status).not.toBe("failed");
    // The abort must not be misread as an expired credential.
    expect(finished?.authErrorProvider).toBeUndefined();
    expect(Object.keys(readState(config.instance).providerAuthFailures ?? {})).toHaveLength(0);
  });

  test("healOrphanedStreamingBlocks settles a terminal task's stuck block but leaves running/queued and post-cutoff blocks alone", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("boot-heal"));
    const cutoff = "2026-06-17T12:00:00.000Z";
    const before = "2026-06-17T11:00:00.000Z"; // < cutoff
    const after = "2026-06-17T13:00:00.000Z"; // >= cutoff

    const setup = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "boot-heal", undefined, "agent_h");
      const mk = (id: string, status: TaskStatus): void => {
        const t = createTask(config.instance, "x", undefined, undefined, undefined, undefined, undefined, session.id);
        t.id = id;
        t.status = status;
        state.tasks.push(t);
      };
      mk("task_done", "completed");
      mk("task_running", "running");
      mk("task_waiting", "waiting_approval");
      return { sessionId: session.id };
    });

    // Helper to plant a streaming:true assistant_text block with a chosen
    // task_id and updated_at, bypassing the live emit path.
    const plant = (callIdMarker: string, taskId: string | null, updatedAt: string): string => {
      const block = insertChatBlock(config.instance, {
        kind: "assistant_text",
        text: `partial ${callIdMarker}`,
        streaming: true,
        sessionId: setup.sessionId,
        ...(taskId ? { taskId } : {})
      });
      // insertChatBlock stamps created_at/updated_at = now(); rewrite updated_at
      // directly so the cutoff predicate is exercised deterministically.
      getMemoryDb(config.instance).run("UPDATE chat_blocks SET updated_at = ? WHERE id = ?", [updatedAt, block.id]);
      return block.id;
    };

    const doneBlock = plant("done", "task_done", before); // terminal + pre-cutoff → heal
    const waitingBlock = plant("waiting", "task_waiting", before); // waiting_approval + pre-cutoff → heal
    const orphanBlock = plant("orphan", "task_gone", before); // absent task + pre-cutoff → heal
    const nullBlock = plant("null", null, before); // no task + pre-cutoff → heal
    const runningBlock = plant("running", "task_running", before); // running → SKIP
    const recentBlock = plant("recent", "task_done", after); // terminal but post-cutoff → SKIP

    const tasksAtBoot = new Map(readState(config.instance).tasks.map((t) => [t.id, t.status]));
    const healed = healOrphanedStreamingBlocks(config.instance, cutoff, (taskId) => {
      if (taskId === null) return true;
      const status = tasksAtBoot.get(taskId);
      if (status === undefined) return true;
      if (status === "running" || status === "queued") return false;
      return isTerminalTaskStatus(status) || status === "waiting_approval";
    });
    expect(healed).toBe(4);

    const blocks = listChatBlocks(config.instance, setup.sessionId);
    const streamingOf = (id: string): boolean =>
      blocks.find((b) => b.id === id && b.kind === "assistant_text")?.kind === "assistant_text" &&
      (blocks.find((b) => b.id === id) as { streaming?: boolean }).streaming === true;
    expect(streamingOf(doneBlock)).toBe(false);
    expect(streamingOf(waitingBlock)).toBe(false);
    expect(streamingOf(orphanBlock)).toBe(false);
    expect(streamingOf(nullBlock)).toBe(false);
    // Running task's block and the post-cutoff block stay streaming.
    expect(streamingOf(runningBlock)).toBe(true);
    expect(streamingOf(recentBlock)).toBe(true);

    // Healed blocks preserve their partial text verbatim.
    const doneText = blocks.find((b) => b.id === doneBlock);
    expect(doneText?.kind === "assistant_text" && doneText.text).toBe("partial done");
  });

  test("resume-path finalize settles a stale streaming block left by a prior process before the resumed turn runs", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("resume-finalize"));
    const provider = normalizeProvider(config.provider);

    // Simulate a boot-resumed orphan: a top-level chat task left at status
    // "running" by a dead process, with a streaming:true assistant_text block
    // it never finalized. reconcileInFlightTasks re-dispatches such a task back
    // through runChatTask — which is what we invoke directly here.
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "resume-finalize", undefined, "agent_r");
      const t = createTask(config.instance, "resume me", undefined, undefined, undefined, undefined, undefined, session.id);
      t.status = "running";
      t.mode = "chat";
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });
    const staleBlock = insertChatBlock(config.instance, {
      kind: "assistant_text",
      text: "half a sentence from the dead process",
      streaming: true,
      sessionId: seeded.sessionId,
      taskId: seeded.taskId
    });

    // The resumed turn's model call answers immediately (no delay).
    setEchoToolCallingResponse({ provider, text: "Fresh answer.", toolCalls: [], finishReason: "stop" });

    const { runChatTask } = await import("./chat-task");
    await runChatTask(config, seeded.taskId);

    const blocks = listChatBlocks(config.instance, seeded.sessionId);
    // The stale pre-restart block must be settled (no longer streaming) with
    // its partial text preserved — not left as a perpetual stuck cursor.
    const stale = blocks.find((b) => b.id === staleBlock.id);
    expect(stale?.kind === "assistant_text" && stale.streaming).toBe(false);
    expect(stale?.kind === "assistant_text" && stale.text).toBe("half a sentence from the dead process");
    // And no assistant_text block is left streaming at all after the turn.
    expect(blocks.some((b) => b.kind === "assistant_text" && b.streaming)).toBe(false);
  });

  test("cancel denies only UNRESOLVED gated tool_call rows — a resolved one being settled by resume stays ok", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("cancel-resolved-skip"));

    // A task paused at waiting_approval whose toolCallState.pending holds two
    // gated calls: one already RESOLVED (result set — an approval that resolved
    // and whose row the resume path settled to `ok`, not yet cleared from the
    // snapshot) and one still UNRESOLVED. cancelTask must deny only the
    // unresolved one; re-flipping the resolved `ok` row to `denied` would
    // mislabel a tool that genuinely ran.
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "cancel-resolved-skip", undefined, "agent_s");
      const t = createTask(config.instance, "gated work", undefined, undefined, undefined, undefined, undefined, session.id);
      t.status = "waiting_approval";
      t.mode = "chat";
      t.toolCallState = {
        messages: [],
        toolsHash: "h",
        iterations: 1,
        pending: [
          { toolCallId: "call_resolved", toolName: "terminal_exec", approvalId: "authz_a", result: "ran ok" },
          { toolCallId: "call_unresolved", toolName: "terminal_exec", approvalId: "authz_b" }
        ]
      };
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });

    // The resolved call's row was already settled to `ok` by the resume path.
    insertChatBlock(config.instance, {
      kind: "tool_call",
      toolName: "terminal_exec",
      displayLabel: "Run shell command",
      argsPreview: "echo ok",
      argsFull: { command: "echo ok" },
      status: "ok",
      callId: "call_resolved",
      sessionId: seeded.sessionId,
      taskId: seeded.taskId
    });
    // The unresolved call's row is still running (genuinely awaiting approval).
    insertChatBlock(config.instance, {
      kind: "tool_call",
      toolName: "terminal_exec",
      displayLabel: "Run shell command",
      argsPreview: "echo wait",
      argsFull: { command: "echo wait" },
      status: "running",
      callId: "call_unresolved",
      sessionId: seeded.sessionId,
      taskId: seeded.taskId
    });

    await cancelTask(config, seeded.taskId);

    const toolCalls = listChatBlocks(config.instance, seeded.sessionId).filter((b) => b.kind === "tool_call");
    const resolved = toolCalls.find((b) => b.kind === "tool_call" && b.callId === "call_resolved");
    const unresolved = toolCalls.find((b) => b.kind === "tool_call" && b.callId === "call_unresolved");
    // The resolved tool keeps its `ok` — not demoted to `denied` by the cancel.
    expect(resolved?.kind === "tool_call" && resolved.status).toBe("ok");
    // The genuinely-unresolved gated tool is settled to `denied`.
    expect(unresolved?.kind === "tool_call" && unresolved.status).toBe("denied");
  });

  test("cancel does not deny a tool whose approval already ran but whose result is not yet recorded", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("cancel-postrun-prerecord"));

    // The post-release/pre-stageResume window: executeApprovedAction ran the
    // side effect, flipped the authorization to `approved`, and released the
    // in-flight registry — but resumeChatTask's stageResume has NOT yet written
    // the result into toolCallState.pending. The task is still
    // waiting_approval, the snapshot entry has no `result`, and the in-flight
    // abort is a no-op (registry already released). A cancel landing here must
    // NOT deny the tool_call row — the side effect genuinely ran and the resume
    // path owns settling it to `ok`. cancel recognizes this by the owning
    // authorization no longer being `pending`.
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "cancel-postrun-prerecord", undefined, "agent_p");
      const t = createTask(config.instance, "gated work", undefined, undefined, undefined, undefined, undefined, session.id);
      t.status = "waiting_approval";
      t.mode = "chat";
      const auth = createAuthorization(state, {
        taskId: t.id,
        action: "terminal.exec",
        target: "echo ran",
        risk: "medium",
        reason: "Run shell command",
        payload: { command: "echo ran", toolCallId: "call_ran" }
      });
      // The approval already resolved (side effect ran) — no longer pending.
      auth.status = "approved";
      // Snapshot still lists the call with NO result (stageResume hasn't run).
      t.toolCallState = {
        messages: [],
        toolsHash: "h",
        iterations: 1,
        pending: [{ toolCallId: "call_ran", toolName: "terminal_exec", approvalId: auth.id }]
      };
      t.approvalIds.push(auth.id);
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });

    // The tool_call row the loop emitted; it's still `running` because the
    // resume path hasn't flipped it to `ok` yet.
    insertChatBlock(config.instance, {
      kind: "tool_call",
      toolName: "terminal_exec",
      displayLabel: "Run shell command",
      argsPreview: "echo ran",
      argsFull: { command: "echo ran" },
      status: "running",
      callId: "call_ran",
      sessionId: seeded.sessionId,
      taskId: seeded.taskId
    });

    await cancelTask(config, seeded.taskId);

    const toolCalls = listChatBlocks(config.instance, seeded.sessionId).filter((b) => b.kind === "tool_call");
    const ran = toolCalls.find((b) => b.kind === "tool_call" && b.callId === "call_ran");
    // The side effect ran, so the row must settle to `ok` — not `denied` (it
    // wasn't denied) and not left `running` (the resume path bails on the now-
    // terminal task without emitting ok, so cancelTask must settle it).
    expect(ran?.kind === "tool_call" && ran.status).toBe("ok");
  });

  test("cancel settles a DENIED approval's tool_call as denied, not ok", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("cancel-denied-auth"));

    // A non-`pending` authorization is NOT proof the side effect ran — it can
    // be `denied`, meaning the action was refused and never executed. cancel
    // must settle such a row as `denied`, never `ok` (emitting ok would mislabel
    // a refused, never-run action as successful — an audit-trust hazard).
    const seeded = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "cancel-denied-auth", undefined, "agent_d");
      const t = createTask(config.instance, "gated work", undefined, undefined, undefined, undefined, undefined, session.id);
      t.status = "waiting_approval";
      t.mode = "chat";
      const auth = createAuthorization(state, {
        taskId: t.id,
        action: "terminal.exec",
        target: "echo nope",
        risk: "medium",
        reason: "Run shell command",
        payload: { command: "echo nope", toolCallId: "call_denied" }
      });
      auth.status = "denied"; // refused — side effect never ran.
      t.toolCallState = {
        messages: [],
        toolsHash: "h",
        iterations: 1,
        pending: [{ toolCallId: "call_denied", toolName: "terminal_exec", approvalId: auth.id }]
      };
      t.approvalIds.push(auth.id);
      state.tasks.push(t);
      return { sessionId: session.id, taskId: t.id };
    });
    insertChatBlock(config.instance, {
      kind: "tool_call",
      toolName: "terminal_exec",
      displayLabel: "Run shell command",
      argsPreview: "echo nope",
      argsFull: { command: "echo nope" },
      status: "running",
      callId: "call_denied",
      sessionId: seeded.sessionId,
      taskId: seeded.taskId
    });

    await cancelTask(config, seeded.taskId);

    const toolCalls = listChatBlocks(config.instance, seeded.sessionId).filter((b) => b.kind === "tool_call");
    const denied = toolCalls.find((b) => b.kind === "tool_call" && b.callId === "call_denied");
    expect(denied?.kind === "tool_call" && denied.status).toBe("denied");
  });
});
