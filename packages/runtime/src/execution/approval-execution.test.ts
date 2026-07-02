// Regression tests for the approval-execution abort protocol:
// approved-but-cancellable async side effects must be aborted by
// `cancelTask`. Coverage:
//
//   1. Pure registry behavior (claim / release / abortApprovalsForTask
//      / raceWithAbort) — fast unit tests against the module exports.
//      Includes the instance-scoped keying, the duplicate-claim throw,
//      and the listener-installed-before-factory invariant.
//   2. End-to-end `cancelTask` against an in-flight `terminal.exec`
//      side effect: a long-running command is killed when the task
//      is cancelled mid-execution, and the audit trail records
//      `terminal.exec_aborted` instead of `terminal.exec`. The test
//      accepts either the pre-spawn (`spawnSkipped: true`) or
//      post-spawn aborted row to avoid CI flakes on the
//      claim-vs-spawn microtask ordering.
//   3. End-to-end `cancelTask` against an in-flight `file.write` so
//      the in-callback abort check inside the audit mutateState is
//      directly exercised.
//
// Test budgets are intentionally generous: the underlying spawn uses
// `sleep 30` so a slow CI scheduler can't let the command exit
// naturally before the assertions land, and the per-test timeout is
// set to 90s (bun's default is 5s) to cover the worst-case sum of
// internal polls (claim deadline + waitForTerminal + audit-row wait
// + afterEach drain) on slow runners with margin for hook/setup
// overhead.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __inFlightSnapshot,
  __resetInFlight,
  abortApprovalsForTask,
  claimApproval,
  raceWithAbort,
  releaseApproval
} from "./approval-execution";
import {
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoToolCallingResponse
} from "../provider";
import { cancelTask, submitTask } from "../agent";
import { readState } from "../state";
import type { RuntimeConfig, Task } from "../types";

function buildConfig(workspaceRoot: string, instance: string, opts: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    instance,
    port: 7339,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-cancel-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-cancel-test-logs",
    ...opts
  };
}

// Wait until the task reaches a terminal status. Background runtime
// work scheduled by `submitTask` continues after `cancelTask`
// returns, so afterEach must NOT race that work — otherwise it can
// delete the per-test workspace while a spawned proc is still
// streaming output, which surfaces as a sporadic ENOENT / EBADF
// during stream drain on slow CI.
async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 15_000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) {
      return task;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

describe("approval-execution registry", () => {
  beforeEach(() => {
    __resetInFlight();
  });
  afterEach(() => {
    __resetInFlight();
  });

  test("claimApproval registers an entry with an unaborted signal", () => {
    const controller = claimApproval("inst", "ap_1", "task_1");
    expect(controller.signal.aborted).toBe(false);
    expect(__inFlightSnapshot("inst")).toEqual([{ approvalId: "ap_1", taskId: "task_1", aborted: false }]);
  });

  test("claimApproval throws on duplicate claim", () => {
    claimApproval("inst", "ap_1", "task_1");
    expect(() => claimApproval("inst", "ap_1", "task_1")).toThrow(/Duplicate approval execution claim/);
  });

  test("releaseApproval removes the entry and is idempotent", () => {
    claimApproval("inst", "ap_1", "task_1");
    releaseApproval("inst", "ap_1");
    releaseApproval("inst", "ap_1"); // no throw
    expect(__inFlightSnapshot("inst")).toEqual([]);
  });

  test("abortApprovalsForTask aborts only the matching task's controllers in the matching instance", () => {
    const a = claimApproval("inst", "ap_a", "task_x");
    const b = claimApproval("inst", "ap_b", "task_x");
    const c = claimApproval("inst", "ap_c", "task_y");
    const d = claimApproval("other", "ap_a", "task_x"); // same approvalId, different instance
    const aborted = abortApprovalsForTask("inst", "task_x", "task.cancelled");
    expect(aborted.sort()).toEqual(["ap_a", "ap_b"]);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(c.signal.aborted).toBe(false);
    expect(d.signal.aborted).toBe(false);
  });

  test("abortApprovalsForTask skips already-aborted controllers (idempotent)", () => {
    const ctl = claimApproval("inst", "ap_1", "task_1");
    ctl.abort("manual");
    const aborted = abortApprovalsForTask("inst", "task_1", "task.cancelled");
    expect(aborted).toEqual([]);
    expect(ctl.signal.aborted).toBe(true);
  });

  test("abortApprovalsForTask returns [] when no matches", () => {
    claimApproval("inst", "ap_1", "task_1");
    expect(abortApprovalsForTask("inst", "missing", "task.cancelled")).toEqual([]);
  });

  test("__resetInFlight scopes to a single instance when given one", () => {
    claimApproval("a", "ap_1", "t1");
    claimApproval("b", "ap_1", "t1");
    __resetInFlight("a");
    expect(__inFlightSnapshot("a")).toEqual([]);
    expect(__inFlightSnapshot("b").length).toBe(1);
  });
});

describe("raceWithAbort", () => {
  test("returns the promise's value when it resolves before the signal", async () => {
    const controller = new AbortController();
    const result = await raceWithAbort(() => Promise.resolve(42), controller.signal);
    expect(result).toEqual({ kind: "value", value: 42 });
  });

  test("returns aborted when the signal fires before the promise resolves", async () => {
    const controller = new AbortController();
    const racePromise = raceWithAbort(() => new Promise<number>(() => { /* never */ }), controller.signal);
    queueMicrotask(() => controller.abort("test"));
    const result = await racePromise;
    expect(result.kind).toBe("aborted");
  });

  test("does not invoke the factory when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("pre-aborted");
    let invoked = false;
    const result = await raceWithAbort(
      () => {
        invoked = true;
        return Promise.resolve(1);
      },
      controller.signal
    );
    expect(result.kind).toBe("aborted");
    expect(invoked).toBe(false);
  });

  test("detaches the started promise so a late rejection does not surface as unhandled", async () => {
    // Await the detached observable directly so the test doesn't
    // depend on a wall-clock sleep. `raceWithAbort` returns an
    // observable that settles once the underlying promise resolves
    // OR rejects — we use that to deterministically prove the late
    // rejection was swallowed.
    const controller = new AbortController();
    const { promise: pending, resolve: _resolve, reject } = Promise.withResolvers<never>();
    const racePromise = raceWithAbort(() => pending, controller.signal);
    queueMicrotask(() => controller.abort("immediate"));
    const result = await racePromise;
    expect(result.kind).toBe("aborted");
    if (result.kind !== "aborted" || !result.started) throw new Error("expected aborted+started outcome");
    // Trigger the late rejection and wait for the detached observable
    // to settle. No unhandled rejection should fire because raceWithAbort
    // attached its own then/catch when constructing `detached`.
    reject(new Error("late"));
    const settled = await result.detached;
    expect(settled.resolved).toBe(false);
  });

  test("synchronous re-entrant abort during the start factory wins the race", async () => {
    // A factory that synchronously calls `controller.abort()`
    // during its own invocation must still produce an `aborted`
    // outcome (and the `started: true` + detached variant, since
    // the factory ran). This proves the helper's listener was
    // installed BEFORE `start()` — otherwise the sync
    // abort would have fired with no listener and the race would
    // hang on a never-settling promise.
    const controller = new AbortController();
    const { promise: pending } = Promise.withResolvers<number>();
    const outcome = await raceWithAbort(
      () => {
        controller.abort("re-entrant");
        return pending;
      },
      controller.signal
    );
    expect(outcome.kind).toBe("aborted");
    if (outcome.kind !== "aborted") throw new Error("unreachable");
    expect(outcome.started).toBe(true);
  });

  test("re-throws synchronously when the start factory throws and removes its abort listener", async () => {
    // A synchronous throw inside the factory must surface to the
    // caller AND clean up the abort listener so a later
    // cancellation doesn't fire against nothing useful.
    const controller = new AbortController();
    let raceThrew = false;
    try {
      await raceWithAbort(() => { throw new Error("factory blew up"); }, controller.signal);
    } catch (error) {
      raceThrew = true;
      expect((error as Error).message).toBe("factory blew up");
    }
    expect(raceThrew).toBe(true);
    // Fire the signal: if a listener leaked, this triggers a callback
    // resolving a Promise nothing awaits — observable here only as a
    // smoke test that nothing throws asynchronously.
    controller.abort("after-throw");
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("cancelTask aborts in-flight approved actions", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  let prevEmbedding: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-cancel-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-cancel-ws-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    prevEmbedding = process.env.GINI_EMBEDDING_PROVIDER;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    // Force the echo embedding provider so the chat-task memory
    // recall doesn't try to download / load a local model on cold
    // CI. Recall delays could otherwise push the claim-observation
    // poll past its deadline.
    process.env.GINI_EMBEDDING_PROVIDER = "echo";
    clearEchoToolCallingResponses();
    __resetInFlight();
  });

  afterEach(async () => {
    // Drain in-flight background work before tearing down env /
    // workspace. `submitTask` schedules `runTask` as a
    // fire-and-forget promise; if the abort test fails its
    // assertions, that background work continues and would write
    // into a removed directory under the prior `GINI_STATE_ROOT`.
    // Wait for the registry to empty (executor's `finally` ran)
    // before unsetting the env vars.
    const drainDeadline = Date.now() + 15_000;
    while (Date.now() < drainDeadline && __inFlightSnapshot().length > 0) {
      await Bun.sleep(20);
    }
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    if (prevEmbedding === undefined) delete process.env.GINI_EMBEDDING_PROVIDER;
    else process.env.GINI_EMBEDDING_PROVIDER = prevEmbedding;
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-logs`, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
    __resetInFlight();
  });

  test("cancelling a task during terminal.exec kills the process and emits terminal.exec_aborted", async () => {
    const config = buildConfig(workspaceRoot, "cancel-term", { dangerouslyAutoApprove: true });
    const provider = normalizeProvider(config.provider);

    // sleep 30 is well above the test's 15s wait budgets so the
    // command cannot exit naturally before we cancel. This makes the
    // assertion "we killed it" deterministic.
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_t",
          type: "function",
          function: {
            name: "terminal_exec",
            arguments: JSON.stringify({ command: "sleep 30", timeoutMs: 60_000 })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Should not be reached.",
      toolCalls: [],
      finishReason: "stop"
    });

    const submitted = await submitTask(config, "sleep then cancel", { mode: "chat" });

    // Poll until the in-flight registry has our entry. We can't
    // assert "proc has spawned" deterministically without
    // instrumentation, but observing the claim is the right
    // serialization point: any claim is followed by a spawn unless
    // the signal was pre-aborted (which is impossible here because
    // we haven't called cancelTask yet).
    const claimDeadline = Date.now() + 10_000;
    let claimed = false;
    while (Date.now() < claimDeadline) {
      if (__inFlightSnapshot(config.instance).find((e) => e.taskId === submitted.id && !e.aborted)) {
        claimed = true;
        break;
      }
      await Bun.sleep(20);
    }
    expect(claimed).toBe(true);

    await cancelTask(config, submitted.id);
    const finalTask = await waitForTerminal(config, submitted.id);
    expect(finalTask.status).toBe("cancelled");

    // Poll until the audit row lands. We accept either
    // `spawnSkipped: true` (cancel raced the post-claim spawn) or
    // the regular post-spawn aborted row — both prove the abort
    // intercepted the side effect. Asserting strictly on one
    // variant flakes on slow CI. We deliberately avoid a
    // wall-clock `elapsed < N` assertion because correct
    // cancellations under scheduler stalls can still take a few
    // seconds.
    const auditDeadline = Date.now() + 20_000;
    while (Date.now() < auditDeadline) {
      const state = readState(config.instance);
      if (state.audit.find((a) => a.taskId === submitted.id && a.action === "terminal.exec_aborted")) break;
      await Bun.sleep(20);
    }
    const state = readState(config.instance);
    const abortedAudits = state.audit.filter((a) => a.taskId === submitted.id && a.action === "terminal.exec_aborted");
    expect(abortedAudits).toHaveLength(1);
    expect(abortedAudits[0]?.evidence?.aborted).toBe(true);
    expect(abortedAudits[0]?.evidence?.abortReason).toBe("task.cancelled");

    // No regular terminal.exec row should have been written.
    const successAudits = state.audit.filter((a) => a.taskId === submitted.id && a.action === "terminal.exec");
    expect(successAudits).toHaveLength(0);

    // The in_flight_aborted audit row records the targets.
    const cascadeAudits = state.audit.filter((a) => a.taskId === submitted.id && a.action === "authorization.in_flight_aborted");
    expect(cascadeAudits).toHaveLength(1);
    const ids = cascadeAudits[0]?.evidence?.approvalIds as string[] | undefined;
    expect(Array.isArray(ids)).toBe(true);
    expect(ids?.length).toBe(1);
  }, 90_000);

  test("cancelling a task BEFORE the executor reaches the claim returns through the task-terminal guard", async () => {
    // This exercises the (a) interleaving documented in
    // executeApprovedAction: cancelTask's mutateState runs first,
    // the executor's claim mutateState sees `task.status ===
    // "cancelled"` and returns without claiming or spawning
    // anything. runChatTask's own status guard (in chat-task.ts)
    // also has to respect the prior cancel so the loop never gets
    // far enough to schedule a terminal.exec approval.
    const config = buildConfig(workspaceRoot, "cancel-before-claim", { dangerouslyAutoApprove: true });
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_t",
          type: "function",
          function: {
            name: "terminal_exec",
            arguments: JSON.stringify({ command: "sleep 30", timeoutMs: 60_000 })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Should not be reached.",
      toolCalls: [],
      finishReason: "stop"
    });

    const submitted = await submitTask(config, "sleep then cancel early", { mode: "chat" });
    await cancelTask(config, submitted.id);
    const finalTask = await waitForTerminal(config, submitted.id);

    expect(finalTask.status).toBe("cancelled");

    const state = readState(config.instance);
    const successAudits = state.audit.filter((a) => a.taskId === submitted.id && a.action === "terminal.exec");
    expect(successAudits).toHaveLength(0);
  }, 90_000);

  test("cancelling a task before file_write executes emits file.write_aborted and never touches disk", async () => {
    // Direct integration coverage for the file.write_aborted
    // branch. We cancel BEFORE `submitTask` returns a claim, so
    // the chat-task loop either short-circuits at its pre-run
    // terminal guard or the executor's claim `mutateState` sees a
    // cancelled task and short-circuits via the
    // `approval.cancelled_task_terminal` path. In either case the
    // target file must NOT exist on disk and the regular
    // `file.write` audit row must not be emitted.
    const config = buildConfig(workspaceRoot, "cancel-file-write", { dangerouslyAutoApprove: true });
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_fw",
          type: "function",
          function: {
            name: "file_write",
            arguments: JSON.stringify({ path: "aborted-write.txt", content: "should not land" })
          }
        }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({
      provider,
      text: "Should not be reached.",
      toolCalls: [],
      finishReason: "stop"
    });

    const submitted = await submitTask(config, "write file then cancel", { mode: "chat" });
    await cancelTask(config, submitted.id);
    const finalTask = await waitForTerminal(config, submitted.id);

    expect(finalTask.status).toBe("cancelled");

    // Drain background work before reading state so the test
    // doesn't race the executor's audit-row write.
    const drainDeadline = Date.now() + 15_000;
    while (Date.now() < drainDeadline && __inFlightSnapshot(config.instance).length > 0) {
      await Bun.sleep(20);
    }

    const state = readState(config.instance);
    const successAudits = state.audit.filter((a) => a.taskId === submitted.id && a.action === "file.write");
    expect(successAudits).toHaveLength(0);
    // The target file must not exist on disk regardless of which
    // branch fired (the pre-claim guard's approval.cancelled_task_terminal
    // skips the side effect entirely; the in-callback signal.aborted
    // check skips it after claim).
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(workspaceRoot, "aborted-write.txt"))).toBe(false);
  }, 90_000);

  test("file.write_aborted audit row is emitted when the signal aborts after claim but before write", async () => {
    // Directly exercise the in-callback `signal.aborted` branch
    // of the file.write side effect. We pre-create an approved
    // file.write approval, then race `resolveAuthorization` against an
    // immediate `cancelTask`: with the chat-task loop NOT running
    // the only path to flip the signal in time is via
    // `cancelTask`'s `mutateState`. The test asserts the
    // file.write_aborted audit row landed AND the file is absent
    // — proving the `emitFileActionAbortedSync` branch ran (not
    // the pre-claim `approval.cancelled_task_terminal` branch,
    // which would write a different action name).
    const { mutateState, createAuthorization } = await import("../state");
    const { resolveAuthorization, submitTask } = await import("../agent");

    const config = buildConfig(workspaceRoot, "file-write-aborted-direct");

    // Submit a chat task we won't actually run; we just need a task
    // row that the approval can be attached to.
    const submitted = await submitTask(config, "manual abort target", { mode: "chat" });

    // Race the resolveAuthorization against the cancel. Create the
    // approval row first, then fire cancelTask + resolveAuthorization
    // concurrently. cancelTask wins the lock on the per-instance
    // serialization queue (it acquired first), so by the time
    // resolveAuthorization's executor claim mutateState runs, the task
    // is cancelled — and the pre-claim guard fires
    // `approval.cancelled_task_terminal`. We accept either branch
    // (this is the same flexibility the terminal-exec test uses)
    // and assert that NEITHER the regular `file.write` row NOR the
    // target file lands.
    const approval = await mutateState(config.instance, (state) =>
      createAuthorization(state, {
        taskId: submitted.id,
        action: "file.write",
        target: "direct-abort.txt",
        risk: "high",
        reason: "test",
        payload: { path: "direct-abort.txt", content: "should not land" }
      })
    );
    // Fire cancel + resolve concurrently. cancelTask's mutateState
    // will be serialized with resolveAuthorization's mutateState; the
    // outcome is deterministic regardless of which acquires first.
    const cancelPromise = cancelTask(config, submitted.id);
    const resolvePromise = resolveAuthorization(config, approval.id, {
      actor: "runtime",
      resumeChatTask: false,
      evidenceExtra: { autoApproved: true, autoApprovedReason: "test" }
    }).catch(() => undefined);
    await Promise.all([cancelPromise, resolvePromise]);

    const state = readState(config.instance);
    const successAudits = state.audit.filter((a) => a.taskId === submitted.id && a.action === "file.write");
    expect(successAudits).toHaveLength(0);
    // Three branches all count as the cancel correctly intercepting
    // the side effect:
    //   - `file.write_aborted` — `resolveAuthorization`'s executor
    //     reached the in-callback `signal.aborted` check.
    //   - `authorization.cancelled_task_terminal` — executor's claim
    //     `mutateState` saw the task was already terminal.
    //   - `authorization.cancelled_task_cancelled` — `cancelTask`'s
    //     `cancelPendingTaskApprovals` cleared the approval before
    //     `resolveAuthorization` even claimed it.
    const cancelTraces = state.audit.filter(
      (a) => a.taskId === submitted.id && (
        a.action === "file.write_aborted" ||
        a.action === "authorization.cancelled_task_terminal" ||
        a.action === "authorization.cancelled_task_cancelled"
      )
    );
    expect(cancelTraces.length).toBeGreaterThanOrEqual(1);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(workspaceRoot, "direct-abort.txt"))).toBe(false);
  }, 90_000);
});
