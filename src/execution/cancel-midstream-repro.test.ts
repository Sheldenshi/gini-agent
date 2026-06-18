// Regression tests for issue #395:
// "Mobile: Cancel/Stop on a running turn shows 'Cancelled' but the agent
//  keeps running."
//
// A turn cancelled while a model call is in flight kept painting: the
// provider call carries no AbortSignal, so cancellation is purely state-based
// and checked only at discrete loop checkpoints. The echo provider's delayMs
// hook holds a model call open, which lets a cancel land while a turn is
// genuinely in flight — the window the report describes. These tests pin the
// observable symptoms:
//
//   1. The in-flight streaming assistant_text block is settled (not left
//      streaming:true) after a mid-stream cancel — no "stuck cursor".
//   2. A routed turn does not append a "Completed" phase after "Cancelled".
//   3. A tool_call awaiting approval is settled (not left `running`) when the
//      task is cancelled — the gate card stops reading as live work.
//   4. A tool_call whose approval row exists but whose loop snapshot has not
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
  createAuthorization,
  createChatSession,
  createSetupRequest,
  createTask,
  insertChatBlock,
  listChatBlocks,
  mutateState,
  readState
} from "../state";
import { submitChatMessage } from "./chat";
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
    const config = buildConfig(makeWorkspace(), "cancel-midstream-cursor", "auto");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "cancel-midstream-cursor", undefined, "agent_y")
    );

    // A slow streaming text turn. The echo provider holds the model call open
    // for delayMs, THEN streams the text through onDelta and returns. We
    // cancel DURING the delay, so cancel lands before the post-delay flush
    // opens the assistant_text block. Before the fix, that post-cancel flush
    // opened a streaming:true block the cancelled bail-out never settled — a
    // perpetually-streaming block with no closer.
    setEchoToolCallingResponse(
      {
        provider,
        text: "I am thinking out loud while the user taps Stop...",
        toolCalls: [],
        finishReason: "stop"
      },
      undefined,
      { delayMs: 400 }
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

  test("a routed turn does not append a 'Completed' phase after 'Cancelled'", async () => {
    const config = buildConfig(makeWorkspace(), "cancel-midstream-route", "auto");
    const provider = normalizeProvider(config.provider);

    const session = await mutateState(config.instance, (state) =>
      createChatSession(state, "cancel-midstream-route", undefined, "agent_r")
    );

    // The model's reply begins with a <route>thread</route> directive. The
    // turn is held open by delayMs; we cancel during the hold. The flush bails
    // on the terminal guard before resolving the route, so the route resolves
    // post-model in finalizeTurnRoute → switchTurnToThread. Without the
    // terminal guard inside switchTurnToThread, it would emit a main-chat
    // "Completed" phase AFTER cancelTask's "Cancelled" phase. We submit via
    // submitChatMessage (not submitTask) so the turn has a user_text block to
    // branch the thread from — otherwise switchTurnToThread bails at no-parent
    // and the buggy emit never runs.
    setEchoToolCallingResponse(
      {
        provider,
        text: "<route>thread</route>Here is the answer in a thread.",
        toolCalls: [],
        finishReason: "stop"
      },
      undefined,
      { delayMs: 400 }
    );

    const submitted = await submitChatMessage(config, session.id, { content: "answer me" }, { bypassQueue: true });
    if ("queued" in submitted) throw new Error("expected run-now submission, got queued");
    const taskId = submitted.taskId;
    // Wait for the "Thinking" phase — the loop emits it right before the (held)
    // model call, so the call is genuinely in flight. Cancelling merely on
    // status "running" can land before "Thinking", bailing at the pre-model
    // guard and never reaching finalizeTurnRoute (where the bug lives).
    await waitFor(() =>
      listChatBlocks(config.instance, session.id).some((b) => b.kind === "phase" && b.label === "Thinking")
    );
    await cancelTask(config, taskId);

    await waitFor(() => {
      const phases = listChatBlocks(config.instance, session.id).filter((b) => b.kind === "phase");
      return phases.some((b) => b.kind === "phase" && b.label === "Cancelled");
    });
    // The buggy "Completed" emit happens LATER than cancel: it fires when the
    // held model call returns (delayMs after submit) and the loop runs
    // finalizeTurnRoute → switchTurnToThread. cancelTask sets the terminal
    // status synchronously, so polling task status reads too early. Wait for
    // the turn to fully drain — the block list stays stable for a window that
    // comfortably exceeds the 400ms model-call delay, so any post-cancel emit
    // has definitely landed.
    await waitForStable(() => listChatBlocks(config.instance, session.id).length, 600);

    const phases = listChatBlocks(config.instance, session.id).filter((b) => b.kind === "phase");
    const cancelledIdx = phases.findIndex((b) => b.kind === "phase" && b.label === "Cancelled");
    expect(cancelledIdx).toBeGreaterThanOrEqual(0);
    // No "Completed" phase may appear at all — and certainly not after the
    // Cancelled marker.
    expect(phases.some((b) => b.kind === "phase" && b.label === "Completed")).toBe(false);
  });

  test("a tool_call awaiting approval is settled (not left running) when the task is cancelled", async () => {
    const config = buildConfig(makeWorkspace(), "cancel-midstream-approval", "strict");
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
      const config = buildConfig(makeWorkspace(), `cancel-mid-dispatch-${variant}`, "strict");

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
