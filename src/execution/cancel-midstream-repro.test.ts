// Regression tests for issue #395:
// "Mobile: Cancel/Stop on a running turn shows 'Cancelled' but the agent
//  keeps running."
//
// A turn cancelled while a model call is in flight kept painting. The "full
// fix" aborts the in-flight model call at the source (covered in
// cancel-abort-signal.test.ts); these tests pin the DEFENSE-IN-DEPTH layer —
// the loop's terminal-status guards that drop deltas/route/blocks which a real
// provider can still deliver in the brief window AFTER the abort fires but
// BEFORE the stream unwinds. The echo `streamAfterAbort` stub models exactly
// that: it holds the call open with delayMs, then swallows the abort and
// streams its text post-cancel, so the guards are genuinely exercised (the
// plain abortable-sleep path rejects first and never reaches them). These
// tests pin the observable symptoms:
//
//   1. The flush guard settles the in-flight streaming assistant_text (not
//      left streaming:true) when a delta arrives post-cancel — no "stuck
//      cursor".
//   2. A tool_call awaiting approval is settled (not left `running`) when the
//      task is cancelled — the gate card stops reading as live work.
//   3. A tool_call whose approval row exists but whose loop snapshot has not
//      yet been persisted is still settled on cancel (the mid-dispatch window).

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
  createSetupRequest,
  createTask,
  insertChatBlock,
  listChatBlocks,
  mutateState,
  readState
} from "../state";
import type { RuntimeConfig } from "../types";

let scratchHome: string;
let prevHome: string | undefined;
let prevState: string | undefined;
let prevLog: string | undefined;
let prevEmbedding: string | undefined;
let root: string;
// Every workspace temp dir minted in a test, torn down in afterEach so the
// suite leaves nothing under the OS temp dir.
const workspaceDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "gini-cancel-repro-ws-"));
  workspaceDirs.push(dir);
  return dir;
}

// Unique instance name per call. getMemoryDb caches the SQLite handle by
// instance, and afterEach deletes the state root; a fixed name reused across
// runs (e.g. `bun test --rerun-each`) would reopen a stale cached handle
// pointing at a deleted file (SQLITE_IOERR_VNODE / "no such savepoint").
let instanceCounter = 0;
function uniqueInstance(base: string): string {
  instanceCounter += 1;
  return `${base}-${instanceCounter}`;
}

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-cancel-repro-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  root = mkdtempSync(join(tmpdir(), "gini-cancel-repro-"));
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

function buildConfig(workspaceRoot: string, instance: string, approvalMode: "auto" | "strict"): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? root,
    logRoot: process.env.GINI_LOG_ROOT ?? `${root}-logs`,
    approvalMode
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

// Resolve once `sample()` returns the SAME value across a sustained window
// (stableMs). Used to wait for an async turn to fully drain when there is no
// positive terminal signal to poll: a late emit (e.g. a model call held open
// by delayMs that returns AFTER cancel) would change the sample, so requiring
// stability for longer than the held-call delay guarantees the turn finished.
async function waitForStable<T>(sample: () => T, stableMs: number, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = sample();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await Bun.sleep(20);
    const current = sample();
    if (current === last) {
      if (Date.now() - stableSince >= stableMs) return current;
    } else {
      last = current;
      stableSince = Date.now();
    }
  }
  throw new Error("waitForStable timed out");
}

describe("issue #395 — cancel mid-stream", () => {
  test("the in-flight streaming assistant_text is settled (not stuck) after a mid-stream cancel", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("cancel-midstream-cursor"), "auto");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "cancel-midstream-cursor", undefined, "agent_y")
    );

    // This pins the DEFENSE-IN-DEPTH flush terminal-status guard, not the
    // source-abort path. streamAfterAbort makes the echo call SWALLOW the abort
    // and still stream its delta AFTER the cancel landed — modeling a real
    // provider that had buffered deltas on the wire when the abort fired (they
    // arrive on a later macrotask before the stream unwinds). The post-cancel
    // flush must then observe terminal status and drop the delta rather than
    // open a streaming:true block the cancelled bail-out never settles (the
    // "stuck cursor"). Without streamAfterAbort the abortable sleep rejects and
    // the flush guard is never reached. (The pure source-abort behavior is
    // covered separately in cancel-abort-signal.test.ts.)
    setEchoToolCallingResponse(
      {
        provider,
        text: "I am thinking out loud while the user taps Stop...",
        toolCalls: [],
        finishReason: "stop"
      },
      undefined,
      { delayMs: 400, streamAfterAbort: true }
    );

    const task = await submitTask(config, "stream me something", {
      mode: "chat",
      chatSessionId: session.id
    });

    // Wait for the "Thinking" phase — the loop emits it right before the (held)
    // model call, so the call is genuinely in flight. Cancelling merely on
    // status "running" can land before the model call starts (a vacuous pass).
    await waitFor(() =>
      listChatBlocks(config.instance, session.id).some((b) => b.kind === "phase" && b.label === "Thinking")
    );
    await cancelTask(config, task.id);

    // cancelTask emits the "Cancelled" phase synchronously, well before the
    // held model call returns — so waiting for that phase alone would let the
    // orphaned loop resume AFTER the assertions and write into a torn-down
    // state dir. Wait for the block list to stay stable past the held-call
    // delay so the post-cancel stream path has fully drained before we assert
    // (and before afterEach removes the state root).
    await waitForStable(() => listChatBlocks(config.instance, session.id).length, 600);

    const blocks = listChatBlocks(config.instance, session.id);
    const stuckStreaming = blocks.filter((b) => b.kind === "assistant_text" && b.streaming);
    expect(stuckStreaming.length).toBe(0);
    expect(readState(config.instance).tasks.find((t) => t.id === task.id)?.status).toBe("cancelled");
    // The terminal "Cancelled" phase is the last phase — no later phase leaked
    // through from the draining loop.
    const phases = blocks.filter((b) => b.kind === "phase");
    const lastPhase = phases[phases.length - 1];
    expect(lastPhase?.kind === "phase" && lastPhase.label).toBe("Cancelled");
  });

  test("a tool_call awaiting approval is settled (not left running) when the task is cancelled", async () => {
    const config = buildConfig(makeWorkspace(), uniqueInstance("cancel-midstream-approval"), "strict");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "cancel-midstream-approval", undefined, "agent_z")
    );

    // The model asks to run a shell command — an approval-gated tool. The loop
    // pauses in waiting_approval with the tool_call row in `running` and an
    // authorization_requested gate card live. This is the "Run shell command"
    // affordance from the issue screenshots.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_shell",
          type: "function",
          function: { name: "terminal_exec", arguments: JSON.stringify({ command: "echo hi" }) }
        }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "run echo hi", {
      mode: "chat",
      chatSessionId: session.id
    });
    await waitFor(() => readState(config.instance).tasks.find((t) => t.id === task.id)?.status === "waiting_approval");

    await cancelTask(config, task.id);

    const blocks = listChatBlocks(config.instance, session.id);
    const toolCalls = blocks.filter((b) => b.kind === "tool_call");
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolCalls.every((b) => b.kind === "tool_call" && b.status !== "running")).toBe(true);
    expect(toolCalls.some((b) => b.kind === "tool_call" && b.callId === "call_shell" && b.status === "denied")).toBe(true);

    const cancelled = readState(config.instance).tasks.find((t) => t.id === task.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.toolCallState).toBeUndefined();
  });

  // The mid-dispatch window: dispatch has emitted the tool_call(running) block
  // and created the pending gate row, but the loop has not yet persisted
  // task.toolCallState (that write only happens once the whole tool-dispatch
  // loop pauses). A cancel landing here must still settle the running block —
  // by reading the durable gate row, not the not-yet-written snapshot.
  // cancelTask sources gated tool-call ids from BOTH authorization and
  // setup-request rows, so we exercise each. We reconstruct that exact state
  // directly (task is running with the gate row created, toolCallState
  // deliberately undefined).
  for (const variant of ["authorization", "setup-request"] as const) {
    test(`cancel settles a gated tool_call from the durable ${variant} row even before the loop snapshot is persisted`, async () => {
      const config = buildConfig(makeWorkspace(), uniqueInstance(`cancel-mid-dispatch-${variant}`), "strict");

      const setup = await mutateState(config.instance, (state) => {
        const session = createChatSession(state, `cancel-mid-dispatch-${variant}`, undefined, "agent_m");
        const task = createTask(config.instance, "run something gated", undefined, undefined, undefined, undefined, undefined, session.id);
        task.status = "running";
        task.mode = "chat";
        state.tasks.push(task);
        if (variant === "authorization") {
          // Pending authorization row (e.g. terminal.exec gate) carrying the
          // gated tool_call id in its payload.
          const auth = createAuthorization(state, {
            taskId: task.id,
            action: "terminal.exec",
            target: "echo hi",
            risk: "medium",
            reason: "Run shell command",
            payload: { command: "echo hi", toolCallId: "call_gated" }
          });
          task.approvalIds.push(auth.id);
        } else {
          // Pending setup-request row (e.g. a connector.request user gate)
          // carrying the gated tool_call id in its payload.
          createSetupRequest(state, {
            taskId: task.id,
            action: "connector.request",
            target: "brave-search",
            reason: "Connect Brave Search",
            payload: { provider: "brave-search", toolCallId: "call_gated" }
          });
        }
        return { sessionId: session.id, taskId: task.id };
      });

      // The tool_call(running) block the loop emitted before dispatch returned.
      insertChatBlock(config.instance, {
        kind: "tool_call",
        toolName: "terminal_exec",
        displayLabel: "Run shell command",
        argsPreview: "echo hi",
        argsFull: { command: "echo hi" },
        status: "running",
        callId: "call_gated",
        sessionId: setup.sessionId,
        taskId: setup.taskId
      });

      await cancelTask(config, setup.taskId);

      const toolCalls = listChatBlocks(config.instance, setup.sessionId).filter((b) => b.kind === "tool_call");
      expect(toolCalls.some((b) => b.kind === "tool_call" && b.callId === "call_gated" && b.status === "denied")).toBe(true);
      expect(toolCalls.every((b) => b.kind === "tool_call" && b.status !== "running")).toBe(true);
    });
  }
});
