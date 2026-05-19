// Hindsight phase 5 — integration tests.
//
// Verify that submitting a task triggers auto-retain on completion (a
// MemoryUnit appears in the bank's SQLite store) and that a follow-up task
// surfaces the prior fact via auto-recall.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { bankIdForAgent, closeAllMemoryDbs, countMemoryUnits, ensureDefaultBank, listMemoryUnits, DEFAULT_BANK_ID } from "../state";
import {
  clearEchoStructuredResponses,
  clearEchoToolCallingResponses,
  normalizeProvider,
  setEchoStructuredResponse,
  setEchoToolCallingResponse
} from "../provider";
import { submitTask } from "../agent";
import { readState } from "../state";
import type { RuntimeConfig } from "../types";

const ROOT = "/tmp/gini-integration-phase5-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
});

afterAll(() => {
  closeAllMemoryDbs();
  clearEchoStructuredResponses();
  clearEchoToolCallingResponses();
  delete process.env.GINI_EMBEDDING_PROVIDER;
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

async function waitForCompletion(config: RuntimeConfig, taskId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const state = readState(config.instance);
    const task = state.tasks.find((entry) => entry.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "waiting_approval")) {
      // Wait a tiny bit more for fire-and-forget retain to flush.
      await Bun.sleep(50);
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("task did not complete");
}

describe("phase 5 — auto-retain on task completion", () => {
  test("submitting a task with non-trivial input grows the memory unit count", async () => {
    const instance = "phase5-retain";
    ensureDefaultBank(instance);
    const before = countMemoryUnits(instance);
    setEchoStructuredResponse("fact-extraction", {
      facts: [
        { what: "user requested a memory test", when: "", where: "", who: "user", why: "verification", fact_type: "world" }
      ]
    });
    const config = makeConfig(instance);
    const task = await submitTask(config, "Verify that auto-retain fires after a normal task completes by storing this input.");
    await waitForCompletion(config, task.id);
    // Wait a little longer for fire-and-forget retain.
    await Bun.sleep(100);
    const after = countMemoryUnits(instance);
    expect(after).toBeGreaterThan(before);
  });

  test("inputs the extractor finds no facts in do not grow memory unit count", async () => {
    // No length threshold — the extractor decides. When it returns an empty
    // fact list, retain is a no-op: zero new memory units. This test was
    // previously named "under threshold" but the threshold was removed so
    // short personal-fact disclosures ("my name is X") aren't dropped.
    const instance = "phase5-skip-trivial";
    ensureDefaultBank(instance);
    setEchoStructuredResponse("fact-extraction", { facts: [] });
    const config = makeConfig(instance);
    const before = countMemoryUnits(instance);
    const task = await submitTask(config, "hi");
    await waitForCompletion(config, task.id);
    await Bun.sleep(100);
    const after = countMemoryUnits(instance);
    expect(after).toBe(before);
  });
});

describe("phase 5 — auto-retain on chat-mode task completion", () => {
  // Regression: chat-mode tasks (web UI path) historically didn't fire
  // scheduleAutoRetain because the call only existed on the legacy
  // runTask code path. Cross-chat recall therefore surfaced nothing for
  // anything the user said in chat. This test pins the wiring so a
  // personal-fact disclosure submitted through the chat-task loop lands
  // in the per-agent memory bank.
  test("submitting a chat-mode task with a personal fact grows the memory unit count", async () => {
    const instance = "phase5-chat-retain";
    ensureDefaultBank(instance);
    const config = makeConfig(instance);
    const provider = normalizeProvider(config.provider);
    // Final answer turn: no tool calls, model just acknowledges. This
    // sends the loop down the result.toolCalls.length === 0 branch in
    // runChatTask's runLoop, which is the path that auto-retain wires
    // into.
    setEchoToolCallingResponse({
      provider,
      text: "Nice to meet you, Shelden.",
      toolCalls: [],
      finishReason: "stop"
    });
    setEchoStructuredResponse("fact-extraction", {
      facts: [
        { what: "user's name is Shelden", when: "", where: "", who: "user", why: "personal disclosure", fact_type: "world" }
      ]
    });
    const before = countMemoryUnits(instance);
    const task = await submitTask(config, "my name is Shelden", { mode: "chat" });
    await waitForCompletion(config, task.id);
    // Fire-and-forget retain — give it a moment to flush like the
    // imperative-path tests above.
    await Bun.sleep(150);
    const after = countMemoryUnits(instance);
    expect(after).toBeGreaterThan(before);
  });
});

describe("phase 5 — auto-recall on task submit", () => {
  test("a follow-up task records that hindsight units were recalled", async () => {
    const instance = "phase5-recall";
    ensureDefaultBank(instance);
    setEchoStructuredResponse("fact-extraction", {
      facts: [
        { what: "user mentioned the secret token swordfish", when: "", where: "", who: "user", why: "demo", fact_type: "world" }
      ]
    });
    const config = makeConfig(instance);
    const first = await submitTask(config, "Please retain the secret token swordfish for testing.");
    await waitForCompletion(config, first.id);
    await Bun.sleep(150);
    // Phase C — auto-retain stamps the active agent, so units land in the
    // per-agent bank rather than the legacy default bank.
    const agentId = readState(config.instance).activeAgentId ?? "agent_default";
    expect(listMemoryUnits(instance, bankIdForAgent(agentId)).length).toBeGreaterThan(0);

    const second = await submitTask(config, "Tell me about the swordfish token from earlier.");
    await waitForCompletion(config, second.id);
    // Inspect the second task's trace for the auto-recall counter set in
    // src/agent.ts.
    const { readTrace } = await import("../state");
    const trace = readTrace(instance, second.id);
    const modelEvent = trace.find((entry) => entry.type === "model");
    expect(modelEvent).toBeDefined();
    const recalledCount = (modelEvent!.data as Record<string, unknown>)["hindsightUnitsRecalled"];
    expect(typeof recalledCount).toBe("number");
    expect(recalledCount as number).toBeGreaterThanOrEqual(1);
  });
});
