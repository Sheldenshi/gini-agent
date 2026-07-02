// Pins the post-claim rollback contract on connector.request /complete: when
// the connector is created and probes HEALTHY but a LATER step (audit, grant,
// or enable) throws, the connector created during THIS attempt must be deleted
// before the failure outcome is persisted. Otherwise the agent re-requests,
// hits the existing-healthy fast path, and skips the missing skill grant —
// leaving the skill env-denied.
//
// Lives in its own file because it spies on `setSkillStatus` (the enable step)
// to force a throw, and the spy is torn down in afterEach so it never leaks
// into the broader suite.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import * as skillsModule from "./capabilities/skills";
import { createHandler } from "./http";
import { createSetupRequest, createSkill, createTask, mutateState, readState, upsertTask } from "./state";
import type { RuntimeConfig } from "./types";

const ROOT = "/tmp/gini-http-rollback-tests";

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterEach(() => {
  // Restore the genuine setSkillStatus so the forced throw never leaks into a
  // test file that runs later in the same process. spyOn + restore reverts the
  // live module binding in place (unlike mock.module, which is not reliably
  // undone).
  (skillsModule.setSkillStatus as ReturnType<typeof spyOn>).mockRestore?.();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

describe("connector.request /complete rolls back a connector created this attempt on a later-step failure", () => {
  test("a throw in the enable step deletes the just-created connector so a re-request starts fresh", async () => {
    const instance = "connreq-rollback";
    rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });

    // Force the enable step to throw AFTER the connector is created + granted.
    // setSkillStatus is the last post-create step in the connector.request
    // branch, so a throw here means: connector created + healthy, grant
    // recorded, enable explodes. http.ts reads setSkillStatus through the live
    // module binding, so spying on it here redirects the handler's call.
    spyOn(skillsModule, "setSkillStatus").mockImplementation(async () => {
      throw new Error("simulated enable failure");
    });

    const config: RuntimeConfig = {
      instance,
      port: 7338,
      token: "test-token",
      provider: { name: "echo", model: "gini-echo-v0" },
      workspaceRoot: "/tmp",
      stateRoot: `${ROOT}/instances/${instance}`,
      logRoot: `${ROOT}-logs/${instance}`,
      approvalMode: "strict"
    };
    const handler = createHandler(config);

    // A skill that declares the credential so the grant guard passes and the
    // handler proceeds to the (spied, throwing) enable step.
    const skill = await mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "needs-rollback-service",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredCredentials: ["ROLLBACK_SERVICE_API_KEY"]
      })
    );

    // A genuine waiting_approval task with a resumable toolCallState so the
    // post-claim resume re-enters the echo loop and the task settles instead of
    // stranding.
    const toolCallId = "call_rollback";
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "connect rollback service");
      task.status = "waiting_approval";
      task.toolCallState = {
        messages: [
          { role: "system", content: "you are gini" },
          { role: "user", content: "connect rollback" },
          { role: "assistant", content: "", tool_calls: [{ id: toolCallId, type: "function", function: { name: "request_connector", arguments: "{}" } }] }
        ],
        toolsHash: "test",
        pending: [{ toolCallId, toolName: "request_connector", approvalId: "" }],
        iterations: 1
      };
      upsertTask(state, task);
      return task.id;
    });

    const approval = await mutateState(config.instance, (state) => {
      const a = createSetupRequest(state, {
        taskId,
        action: "connector.request",
        target: "ROLLBACK_SERVICE_API_KEY",
        reason: "Enter your Rollback Service API key",
        payload: {
          credentialName: "ROLLBACK_SERVICE_API_KEY",
          credentialType: "api-key",
          credentialLabel: "Rollback Service",
          skillId: skill.id,
          reason: "Enter your Rollback Service API key",
          toolCallId
        }
      });
      const item = state.tasks.find((t) => t.id === taskId)!;
      item.toolCallState!.pending[0]!.approvalId = a.id;
      item.approvalIds.push(a.id);
      return a;
    });

    const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/setup-requests/${approval.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ secrets: { ROLLBACK_SERVICE_API_KEY: "sk-rollback-secret" } })
    }));
    const body = await response.json();
    // Structured failure (the catch ran), not the bare catch-all 500.
    expect(body.ok).toBe(false);
    expect(body.message).toContain("simulated enable failure");

    const state = readState(config.instance);
    // The connector created during this attempt was rolled back — NOTHING under
    // the requested name remains, so a re-request creates + grants cleanly.
    expect(state.connectors.filter((c) => c.name === "ROLLBACK_SERVICE_API_KEY").length).toBe(0);
    // The setup row is claimed with a persisted failure outcome.
    const resolved = state.setupRequests.find((a) => a.id === approval.id);
    expect(resolved?.status).toBe("completed");
    expect(resolved?.connectOutcome?.ok).toBe(false);
  });
});
