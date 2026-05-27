import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createHandler } from "./http";
import { addAudit, appendEvent, mutateState, readState, readTrace } from "./state";
import type { RuntimeConfig } from "./types";

describe("runtime api", () => {
  test("applies approved improvement proposals and audits the decision", async () => {
    const config = testConfig("improvement-approve");
    const handler = createHandler(config);

    const proposal = await call(handler, config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({
        kind: "skill",
        title: "review-traces",
        rationale: "Trace evidence shows repeated review steps.",
        payload: { name: "review-traces", steps: ["Inspect trace", "Summarize evidence"] }
      })
    });

    const applied = await call(handler, config, `/api/improvements/${proposal.id}/approve`, { method: "POST" });
    const state = readState(config.instance);

    expect(applied.status).toBe("applied");
    expect(applied.appliedTargetId).toBeString();
    expect(state.skills.some((skill) => skill.id === applied.appliedTargetId)).toBe(true);
    expect(state.audit.some((event) => event.action === "improvement.applied")).toBe(true);
  });

  test("rejected improvement proposals do not mutate target stores", async () => {
    const config = testConfig("improvement-reject");
    const handler = createHandler(config);

    const proposal = await call(handler, config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({
        kind: "skill",
        title: "Remember review preference",
        payload: { name: "review-pref", description: "Prefer evidence-backed reviews.", trigger: "review", steps: ["Cite evidence"] }
      })
    });

    const rejected = await call(handler, config, `/api/improvements/${proposal.id}/reject`, { method: "POST" });
    const state = readState(config.instance);

    expect(rejected.status).toBe("rejected");
    expect(state.skills.some((skill) => skill.name === "review-pref")).toBe(false);
    expect(state.audit.some((event) => event.action === "improvement.rejected")).toBe(true);
  });

  test("pairs devices with one-time codes and redacts stored secrets", async () => {
    const config = testConfig("pairing");
    const handler = createHandler(config);

    const pairing = await call(handler, config, "/api/pairing", { method: "POST", body: JSON.stringify({ ttlSeconds: 60 }) });
    const claimed = await callPublic(handler, config, "/api/pairing/claim", {
      method: "POST",
      body: JSON.stringify({ code: pairing.code, deviceName: "Test phone" })
    });
    const mobile = await callWithToken(handler, config, claimed.token, "/api/mobile/bootstrap");
    const devices = await call(handler, config, "/api/devices");
    const state = await call(handler, config, "/api/state");

    expect(mobile.instance).toBe(config.instance);
    expect(devices[0].name).toBe("Test phone");
    expect(JSON.stringify(state)).not.toContain("tokenHash");
    expect(JSON.stringify(state)).not.toContain("codeHash");
    expect(JSON.stringify(state)).not.toContain(claimed.token);
  });

  test("revoked device tokens cannot use mobile contracts", async () => {
    const config = testConfig("pairing-revoke");
    const handler = createHandler(config);

    const pairing = await call(handler, config, "/api/pairing", { method: "POST" });
    const claimed = await callPublic(handler, config, "/api/pairing/claim", {
      method: "POST",
      body: JSON.stringify({ code: pairing.code, deviceName: "Revoked phone" })
    });
    await call(handler, config, `/api/devices/${claimed.device.id}/revoke`, { method: "POST" });
    const response = await rawCall(handler, config, "/api/mobile/bootstrap", {}, claimed.token);

    expect(response.status).toBe(401);
  });

  test("records promotion proposals without applying upgrades", async () => {
    const config = testConfig("promotion");
    const handler = createHandler(config);

    const proposal = await call(handler, config, "/api/promotions", {
      method: "POST",
      body: JSON.stringify({
        candidateRef: "commit-abc",
        evidencePath: "/tmp/evidence.json",
        summary: "Candidate passed sandbox smoke.",
        rollbackPlan: "Restore snapshot snap_abc."
      })
    });
    const rejected = await call(handler, config, `/api/promotions/${proposal.id}/reject`, { method: "POST" });

    expect(rejected.status).toBe("rejected");
    expect(rejected.candidateRef).toBe("commit-abc");
    expect(readState(config.instance).audit.some((event) => event.action === "promotion.rejected")).toBe(true);
  });

  test("supports Hermes-parity control records for search, toolsets, subagents, MCP, messaging, and imports", async () => {
    const config = testConfig("hermes-parity");
    const handler = createHandler(config);

    const task = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "remember Hermes parity should be searchable" })
    });
    await waitForTask(handler, config, task.id);

    const search = await call(handler, config, "/api/search?q=Hermes");
    const toolsets = await call(handler, config, "/api/toolsets");
    const disabled = await call(handler, config, "/api/toolsets/messaging/disable", { method: "POST" });
    const subagent = await call(handler, config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({ name: "reviewer", prompt: "review Hermes parity", parentTaskId: task.id, toolsets: ["memory"] })
    });
    await waitForTask(handler, config, subagent.taskId);
    const mcp = await call(handler, config, "/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name: "demo-mcp", command: "echo", args: ["ok"], exposedTools: ["demo.echo"] })
    });
    const bridge = await call(handler, config, "/api/messaging", {
      method: "POST",
      body: JSON.stringify({ name: "demo-bridge", kind: "demo", deliveryTargets: ["local"] })
    });
    const report = await call(handler, config, "/api/imports/inspect", {
      method: "POST",
      body: JSON.stringify({ source: "hermes", path: process.cwd() })
    });

    expect(search.length).toBeGreaterThan(0);
    expect(toolsets.toolsets.some((item: { name: string }) => item.name === "session_search")).toBe(true);
    expect(disabled.status).toBe("disabled");
    expect(subagent.taskId).toBeString();
    expect(mcp.status).toBe("configured");
    expect(bridge.status).toBe("configured");
    expect(report.status).toBe("completed");
  });

  test("executes low-risk file tool tasks with trace and audit evidence", async () => {
    const config = testConfig("file-tools");
    config.workspaceRoot = process.cwd();
    const handler = createHandler(config);

    const read = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "read README.md" })
    });
    const readDetail = await waitForTask(handler, config, read.id);
    const list = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "list src" })
    });
    const listDetail = await waitForTask(handler, config, list.id);
    const find = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "find Gini in README.md" })
    });
    const findDetail = await waitForTask(handler, config, find.id);
    const state = readState(config.instance);

    expect(readDetail.task.status).toBe("completed");
    expect(listDetail.task.summary).toContain("src/agent.ts");
    expect(findDetail.task.summary).toContain("README.md");
    expect(state.audit.some((event) => event.action === "file.read")).toBe(true);
    expect(state.audit.some((event) => event.action === "file.list")).toBe(true);
    expect(state.audit.some((event) => event.action === "file.search")).toBe(true);
  });

  test("supports agent config equivalents and Hermes parity reporting", async () => {
    const config = testConfig("agents-parity");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "research", toolsets: ["file", "web", "session_search"] })
    });
    const active = await call(handler, config, `/api/agents/${created.id}/use`, { method: "POST" });
    const agents = await call(handler, config, "/api/agents");
    const parity = await call(handler, config, "/api/parity/hermes");

    expect(active.status).toBe("active");
    expect(agents.activeAgentId).toBe(created.id);
    expect(parity.ok).toBe(true);
    expect(parity.checks.some((item: { id: string; status: string }) => item.id === "agents" && item.status === "pass")).toBe(true);
  });

  test("DELETE /api/agents/:id removes the agent and cascades cleanup", async () => {
    const config = testConfig("agents-delete");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scratch" })
    });
    const deleted = await call(handler, config, `/api/agents/${created.id}`, { method: "DELETE" });

    expect(deleted.ok).toBe(true);
    expect(deleted.id).toBe(created.id);
    expect(deleted.bankDeleted).toBe(true);

    const after = await call(handler, config, "/api/agents");
    expect(after.agents.find((agent: { id: string }) => agent.id === created.id)).toBeUndefined();

    // Idempotent: a second delete on the same id returns 404, not 500.
    const followUp = await rawCall(handler, config, `/api/agents/${created.id}`, { method: "DELETE" }, config.token);
    expect(followUp.status).toBe(404);
  });

  test("DELETE /api/agents/:id rejects the default agent with 400", async () => {
    const config = testConfig("agents-delete-default");
    const handler = createHandler(config);
    const response = await rawCall(handler, config, "/api/agents/agent_default", { method: "DELETE" }, config.token);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Cannot delete the default agent");
  });

  test("DELETE /api/agents/:id rejects the active agent with 400", async () => {
    const config = testConfig("agents-delete-active");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "active" })
    });
    await call(handler, config, `/api/agents/${created.id}/use`, { method: "POST" });

    const response = await rawCall(handler, config, `/api/agents/${created.id}`, { method: "DELETE" }, config.token);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Cannot delete the active agent");
  });

  test("supports relay degraded health and notification delivery records", async () => {
    const config = testConfig("relay-notifications");
    const handler = createHandler(config);

    const relay = await call(handler, config, "/api/relays", {
      method: "POST",
      body: JSON.stringify({ name: "local", endpoint: "local://test", mode: "local-only" })
    });
    const health = await call(handler, config, `/api/relays/${relay.id}/health`, { method: "POST" });
    const notification = await call(handler, config, "/api/notifications", {
      method: "POST",
      body: JSON.stringify({ kind: "runtime", target: "local", title: "Runtime check", body: "Relay test" })
    });
    const sent = await call(handler, config, "/api/notifications/send", { method: "POST" });

    expect(health.status).toBe("degraded");
    expect(notification.status).toBe("queued");
    expect(sent.some((item: { id: string; status: string }) => item.id === notification.id && item.status === "sent")).toBe(true);
  });

  test("supports V1 skill governance and job run history workflows", async () => {
    const config = testConfig("v1-skill-job");
    const handler = createHandler(config);

    const skill = await call(handler, config, "/api/skills", {
      method: "POST",
      body: JSON.stringify({ name: "triage", steps: ["Read trace"], tests: ["has name"] })
    });
    const enabled = await call(handler, config, `/api/skills/${skill.id}/enable`, { method: "POST" });
    const tested = await call(handler, config, `/api/skills/${skill.id}/test`, { method: "POST" });
    const updated = await call(handler, config, `/api/skills/${skill.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Updated skill", steps: ["Read trace", "Summarize"] })
    });
    const rolledBack = await call(handler, config, `/api/skills/${skill.id}/rollback`, { method: "POST" });

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "script", intervalSeconds: 60, script: "echo script-ok", deliveryTargets: ["local"], timeoutSeconds: 5 })
    });
    const run = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    const runs = await call(handler, config, `/api/jobs/${job.id}/runs`);
    const replay = await call(handler, config, `/api/job-runs/${runs[0].id}/replay`, { method: "POST" });
    const events = await call(handler, config, "/api/events");

    expect(enabled.status).toBe("enabled");
    expect(tested.ok).toBe(true);
    expect(updated.version).toBe(2);
    expect(rolledBack.version).toBe(3);
    expect(run.exitCode).toBe(0);
    expect(runs[0].summary).toContain("script-ok");
    expect(replay.exitCode).toBe(0);
    expect(events.some((event: { action: string }) => event.action === "job.run.completed")).toBe(true);
  });

  test("PATCH /api/jobs/:id round-trips costBudget alongside other editable fields", async () => {
    const config = testConfig("v1-job-cost-budget");
    const handler = createHandler(config);

    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "cost-job", intervalSeconds: 120, prompt: "noop" })
    });
    expect(job.costBudget).toBeUndefined();

    const patched = await call(handler, config, `/api/jobs/${job.id}`, {
      method: "PATCH",
      body: JSON.stringify({ costBudget: 2.5, retryLimit: 4, timeoutSeconds: 45 })
    });
    expect(patched.costBudget).toBe(2.5);
    expect(patched.retryLimit).toBe(4);
    expect(patched.timeoutSeconds).toBe(45);

    const refetched = (await call(handler, config, "/api/jobs")).find((item: { id: string }) => item.id === job.id);
    expect(refetched.costBudget).toBe(2.5);

    const cleared = await call(handler, config, `/api/jobs/${job.id}`, {
      method: "PATCH",
      body: JSON.stringify({ costBudget: null })
    });
    expect(cleared.costBudget).toBeUndefined();
  });

  test("probes and invokes configured MCP command records", async () => {
    const config = testConfig("v1-mcp");
    const handler = createHandler(config);

    const server = await call(handler, config, "/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name: "echo-mcp", command: "echo", args: ["ok"], exposedTools: ["echo.tool"] })
    });
    const health = await call(handler, config, `/api/mcp/${server.id}/health`, { method: "POST" });
    const invoked = await call(handler, config, `/api/mcp/${server.id}/invoke`, {
      method: "POST",
      body: JSON.stringify({ toolName: "echo.tool", input: { value: 1 } })
    });

    expect(health.status).toBe("configured");
    expect(health.message).toContain("completed");
    expect(invoked.ok).toBe(true);
    expect(invoked.stdout).toContain("ok");
  });

  test("exposes recorded runtime events as an SSE stream", async () => {
    const config = testConfig("events-stream");
    const handler = createHandler(config);

    await call(handler, config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({ kind: "skill", title: "event-test", payload: { name: "event-test" } })
    });
    const response = await rawCall(handler, config, "/api/events/stream", {}, config.token);
    const reader = response.body?.getReader();
    const chunk = await reader?.read();
    await reader?.cancel();
    const text = new TextDecoder().decode(chunk?.value);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("data:");
    expect(text).toContain("event_");
  });

  test("SSE stream honors Last-Event-ID for reconnect dedup", async () => {
    // Regression for the Round 2 reconnect storm: every reconnect was
    // re-replaying the entire event log, which compounded into thousands of
    // events/sec on the client when the EventSource thrashed. With dedup, a
    // reconnect that includes the most-recent id should yield zero historical
    // events on first read.
    const config = testConfig("events-stream-dedup");
    const handler = createHandler(config);

    await call(handler, config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({ kind: "skill", title: "first", payload: { name: "first" } })
    });
    // Read the full event log once to discover the most-recent id.
    const events = await call(handler, config, "/api/events");
    expect(events.length).toBeGreaterThan(0);
    const lastEventId = events[events.length - 1].id;

    const response = await rawCall(
      handler,
      config,
      "/api/events/stream",
      { headers: { "last-event-id": lastEventId } },
      config.token
    );
    // First read should yield no historical events (everything up to and
    // including lastEventId is suppressed). The TextDecoder.decode of an empty
    // chunk is "".
    const reader = response.body?.getReader();
    // Race the read against a short timeout; the heartbeat doesn't fire for
    // 1s, so an immediate read should observe an empty buffer.
    const winner = await Promise.race([
      reader?.read(),
      new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 200))
    ]) as { value?: Uint8Array; done?: boolean };
    await reader?.cancel();
    const text = winner?.value ? new TextDecoder().decode(winner.value) : "";
    expect(text).toBe("");
  });

  test("SSE Last-Event-ID older than retained buffer still delivers retained events", async () => {
    // Regression for R3-G1: when the client's Last-Event-ID has rolled out of
    // the 1000-event ring buffer (long disconnect or burst), we must NOT
    // silently pre-seed every retained event into `seen` — that would deliver
    // nothing on reconnect and the client would never recover. Instead, treat
    // the unknown id as "best effort" and ship the entire retained window.
    const config = testConfig("events-stream-rollover");
    const handler = createHandler(config);

    // Generate more events than the ring buffer holds (1000), so a fabricated
    // earlier id is guaranteed not to be retained.
    await mutateState(config.instance, (state) => {
      for (let i = 0; i < 1100; i += 1) {
        appendEvent(
          state,
          {
            kind: "runtime",
            action: "noop",
            target: `target-${i}`,
            risk: "low",
            summary: `event ${i}`
          },
          { system: true }
        );
      }
    });

    // Construct a stale Last-Event-ID that mimics the ID format but isn't in
    // the buffer. (The buffer holds the last 1000; this id is intentionally
    // synthetic and won't match any retained event.)
    const staleId = "event_rolled_out_of_buffer";

    const response = await rawCall(
      handler,
      config,
      "/api/events/stream",
      { headers: { "last-event-id": staleId } },
      config.token
    );
    const reader = response.body?.getReader();
    const winner = (await Promise.race([
      reader?.read(),
      new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 200))
    ])) as { value?: Uint8Array; done?: boolean };
    await reader?.cancel();
    const text = winner?.value ? new TextDecoder().decode(winner.value) : "";

    // Should have received the retained window, not silence.
    expect(text).toContain("data:");
    expect(text).toContain("event_");
  });

  test("supports local chat sessions backed by task execution and retry contracts", async () => {
    const config = testConfig("chat");
    const handler = createHandler(config);

    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "Hermes-style chat" })
    });
    const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "remember chat history works" })
    });
    await waitForTask(handler, config, submitted.taskId);
    const assistant = await call(handler, config, `/api/chat/${session.id}/tasks/${submitted.taskId}/sync`, { method: "POST" });
    const retry = await call(handler, config, `/api/tasks/${submitted.taskId}/retry`, { method: "POST" });
    const detail = await call(handler, config, `/api/chat/${session.id}`);

    expect(assistant.role).toBe("assistant");
    expect(retry.input).toContain("remember chat history works");
    expect(detail.messages).toHaveLength(2);
    expect(detail.taskIds).toContain(submitted.taskId);
  });

  test("approval-gated file patch produces a diff approval", async () => {
    // Memory CRUD via `/api/memory` was removed alongside the
    // state.memories consolidation. See ADR
    // runtime-identity-files.md.
    const config = testConfig("memory-patch");
    config.workspaceRoot = process.cwd();
    const handler = createHandler(config);

    const task = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "patch README.md :: Gini => Gini" })
    });
    const detail = await waitForTask(handler, config, task.id);
    const approval = readState(config.instance).approvals.find((item) => item.taskId === task.id);

    expect(detail.task.status).toBe("waiting_approval");
    expect(approval?.action).toBe("file.patch");
    expect(String(approval?.payload.diff)).toContain("--- before");
  });

  test("routes messaging bridge input to tasks and records outbound delivery", async () => {
    const config = testConfig("messaging-routing");
    const handler = createHandler(config);

    const bridge = await call(handler, config, "/api/messaging", {
      method: "POST",
      body: JSON.stringify({ name: "local-messages", kind: "demo", deliveryTargets: ["local"] })
    });
    const inbound = await call(handler, config, `/api/messaging/${bridge.id}/receive`, {
      method: "POST",
      body: JSON.stringify({ text: "remember message bridge works", target: "local" })
    });
    await waitForTask(handler, config, inbound.taskId);
    const outbound = await call(handler, config, `/api/messaging/${bridge.id}/send`, {
      method: "POST",
      body: JSON.stringify({ text: "Task is visible in Gini", target: "local" })
    });
    const messages = await call(handler, config, `/api/messaging/${bridge.id}/messages`);

    expect(inbound.direction).toBe("inbound");
    expect(inbound.status).toBe("received");
    expect(outbound.status).toBe("sent");
    expect(messages).toHaveLength(2);
  });

  test("rejects send to a target outside the active agent's messagingTargets filter", async () => {
    const config = testConfig("messaging-agent-filter");
    const handler = createHandler(config);

    // Bridge advertises two targets so the per-call `target` selector has
    // something to disagree with the agent filter about.
    const bridge = await call(handler, config, "/api/messaging", {
      method: "POST",
      body: JSON.stringify({ name: "multi", kind: "demo", deliveryTargets: ["local", "slack"] })
    });
    const agent = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "local-only", toolsets: ["file"], messagingTargets: ["local"] })
    });
    await call(handler, config, `/api/agents/${agent.id}/use`, { method: "POST" });

    // local target is permitted → succeeds.
    const allowed = await call(handler, config, `/api/messaging/${bridge.id}/send`, {
      method: "POST",
      body: JSON.stringify({ text: "ok", target: "local" })
    });
    expect(allowed.status).toBe("sent");

    // slack is outside the agent filter → server returns 400 with a typed
    // error message that names both target and agent.
    const rejected = await rawCall(handler, config, `/api/messaging/${bridge.id}/send`, {
      method: "POST",
      body: JSON.stringify({ text: "nope", target: "slack" })
    }, config.token);
    expect(rejected.ok).toBe(false);
    const errorBody = await rejected.json();
    expect(String(errorBody.error)).toContain("not permitted by active agent");
    expect(String(errorBody.error)).toContain("slack");
  });

  test("returns a JSON pointer at GET / instead of static HTML", async () => {
    const config = testConfig("root-pointer");
    const handler = createHandler(config);

    const response = await handler(new Request(`http://127.0.0.1:${config.port}/`));
    const value = (await response.json()) as { name?: string; instance?: string; message?: string };

    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(value.name).toBe("gini-runtime");
    expect(value.instance).toBe(config.instance);
    expect(String(value.message)).toContain("Next.js");
  });

  test("preserves full terminal stdout in a trace artifact when audit evidence is truncated", async () => {
    // Master plan §6.2 requires that "outputs are truncated intelligently
    // with full logs stored." The audit `evidence` field caps stdout/stderr
    // at 4KB for at-a-glance inline reading, but the full text must remain
    // retrievable. agent.executeApprovedAction writes a sibling artifact
    // under the task's trace directory and references it from both the
    // audit evidence and the trace record.
    const config = testConfig("terminal-output-preservation");
    config.workspaceRoot = "/tmp";
    const handler = createHandler(config);

    // Generate >4KB of stdout to force the inline excerpt to truncate.
    const command = "yes abcdefghij | head -n 500";
    const submitted = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: `shell ${command}` })
    });
    const detail = await waitForTask(handler, config, submitted.id);
    expect(detail.task.status).toBe("waiting_approval");

    const approval = readState(config.instance).approvals.find((item) => item.taskId === submitted.id);
    expect(approval).toBeDefined();
    await call(handler, config, `/api/approvals/${approval!.id}/approve`, { method: "POST" });

    const finalDetail = await waitForTask(handler, config, submitted.id);
    expect(finalDetail.task.status).toBe("completed");

    const auditEntry = readState(config.instance).audit.find(
      (event) => event.action === "terminal.exec" && event.taskId === submitted.id
    );
    expect(auditEntry).toBeDefined();
    const evidence = auditEntry!.evidence as Record<string, unknown>;

    // Inline excerpt is truncated at 4000 bytes for display, but the audit
    // carries metadata that signals truncation and points at the artifact.
    expect(typeof evidence.stdout).toBe("string");
    expect((evidence.stdout as string).length).toBeLessThanOrEqual(4000);
    expect(evidence.stdoutTruncated).toBe(true);
    expect(typeof evidence.stdoutBytes).toBe("number");
    expect(evidence.stdoutBytes as number).toBeGreaterThan(4000);
    expect(typeof evidence.artifactPath).toBe("string");
    expect(typeof evidence.artifactRelPath).toBe("string");
    expect(String(evidence.artifactRelPath)).toContain(`traces/${submitted.id}/terminal-`);

    // The artifact file actually exists and contains the full output.
    const artifactPath = String(evidence.artifactPath);
    expect(existsSync(artifactPath)).toBe(true);
    const body = readFileSync(artifactPath, "utf8");
    expect(body).toContain("--- stdout");
    expect(body).toContain("--- stderr");
    expect(body.length).toBeGreaterThan(4000);

    // The trace record for the executed command also references the artifact
    // so the Tasks timeline UI can surface a "View full output" affordance.
    const trace = readTrace(config.instance, submitted.id);
    const toolRecord = trace.find(
      (record) => record.type === "tool" && record.message === "Command executed"
    );
    expect(toolRecord).toBeDefined();
    const data = toolRecord!.data as Record<string, unknown>;
    expect(data.stdoutTruncated).toBe(true);
    expect(typeof data.artifactRelPath).toBe("string");
  });

  test("reports V1 readiness from runtime evidence", async () => {
    const config = testConfig("readiness");
    const handler = createHandler(config);

    await call(handler, config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({ kind: "skill", title: "readiness", payload: { name: "readiness" } })
    });
    const readiness = await call(handler, config, "/api/readiness/v1");

    expect(readiness.ok).toBe(true);
    expect(readiness.checks.some((item: { id: string; status: string }) => item.id === "future_app_contracts" && item.status === "pass")).toBe(true);
  });

  test("models chat work as conversation runs with plan steps and compatibility tasks", async () => {
    const config = testConfig("conversation-runs");
    const handler = createHandler(config);

    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "Planful chat" })
    });
    const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "remember conversation runs are the execution layer" })
    });
    await waitForTask(handler, config, submitted.taskId);
    await call(handler, config, `/api/chat/${session.id}/tasks/${submitted.taskId}/sync`, { method: "POST" });

    const run = await call(handler, config, `/api/runs/${submitted.runId}`);
    const chat = await call(handler, config, `/api/chat/${session.id}`);
    const runs = await call(handler, config, "/api/runs");

    expect(run.kind).toBe("conversation_turn");
    expect(run.status).toBe("completed");
    expect(run.task.id).toBe(submitted.taskId);
    expect(run.planSteps.length).toBeGreaterThanOrEqual(2);
    expect(chat.runIds).toContain(submitted.runId);
    expect(chat.messages.some((message: { role: string; runId?: string }) => message.role === "assistant" && message.runId === submitted.runId)).toBe(true);
    expect(runs.some((item: { id: string }) => item.id === submitted.runId)).toBe(true);
  });

  test("connector CRUD round-trips through /api/connectors without persisting plaintext secrets", async () => {
    const config = testConfig("connector-crud");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/connectors", {
      method: "POST",
      body: JSON.stringify({ provider: "linear", name: "primary linear", scopes: ["read"], secrets: { token: "lin_secret_abc" } })
    });

    expect(created.provider).toBe("linear");
    expect(created.secretRefs).toHaveLength(1);
    expect(created.secretRefs[0].purpose).toBe("token");
    // User-source default — only the auto-detection job emits "auto".
    expect(created.source).toBe("user");
    const raw = readFileSync(`${config.stateRoot}/state.json`, "utf8");
    expect(raw).not.toContain("lin_secret_abc");

    const listed = await call(handler, config, "/api/connectors");
    expect(listed.some((item: { id: string }) => item.id === created.id)).toBe(true);

    await call(handler, config, `/api/connectors/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ secrets: { token: "lin_secret_xyz" } })
    });
    const auditAfterRotate = readState(config.instance).audit;
    expect(auditAfterRotate.some((event) => event.action === "connector.rotate")).toBe(true);

    await call(handler, config, `/api/connectors/${created.id}`, { method: "DELETE" });
    const after = await call(handler, config, "/api/connectors");
    expect(after.some((item: { id: string }) => item.id === created.id)).toBe(false);
    expect(existsSync(`${config.stateRoot}/secrets/${created.id}.token.json`)).toBe(false);
  });

  test("deleting an auto-source connector tombstones the record with status=disabled", async () => {
    const config = testConfig("connector-tombstone");
    const handler = createHandler(config);
    // Seed an auto-source connector directly on state (detection runs on
    // the live gateway; this test boots a one-shot handler so we inject
    // the record by hand).
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      state.connectors.push({
        id: "id_auto_test",
        instance: state.instance,
        name: "auto-codex",
        provider: "codex",
        status: "configured",
        scopes: [],
        secretRefs: [],
        createdAt: at,
        updatedAt: at,
        health: "healthy",
        source: "auto"
      });
    });
    const result = await call(handler, config, "/api/connectors/id_auto_test", { method: "DELETE" });
    expect(result.tombstoned).toBe(true);
    const state = readState(config.instance);
    const record = state.connectors.find((c) => c.id === "id_auto_test");
    expect(record?.status).toBe("disabled");
    expect(state.audit.some((event) => event.action === "connector.disable")).toBe(true);
  });

  test("POST /api/connectors/detect runs the detection job and is idempotent", async () => {
    const config = testConfig("connector-detect-endpoint");
    const handler = createHandler(config);
    const first = await call(handler, config, "/api/connectors/detect", { method: "POST" });
    expect(first).toHaveProperty("considered");
    expect(first).toHaveProperty("created");
    // The second call should not create any new records — the detection
    // logic is idempotent at the registry+state level.
    const second = await call(handler, config, "/api/connectors/detect", { method: "POST" });
    const createdProviders = (second.created as Array<{ provider: string }>).map((c) => c.provider);
    expect(createdProviders).toEqual([]);
  });

  test("GET /api/connectors/providers returns the registry", async () => {
    const config = testConfig("providers-list");
    const handler = createHandler(config);
    const providers = await call(handler, config, "/api/connectors/providers");
    expect(Array.isArray(providers)).toBe(true);
    const ids = providers.map((p: { id: string }) => p.id);
    expect(ids).toContain("demo");
    expect(ids).toContain("linear");
    expect(ids).toContain("generic");
    expect(ids).toContain("claude-code");
    expect(ids).toContain("codex");
  });

  test("POST /api/approvals/<id>/connect creates a connector and resolves the approval on probe success", async () => {
    const config = testConfig("approvals-connect-happy");
    const handler = createHandler(config);
    // Stage a connector.request approval row directly. Demo provider has no
    // probe, so checkConnector falls back to presence-only ⇒ healthy without
    // any network mocking.
    const { createApproval } = await import("./state");
    const approval = await mutateState(config.instance, (state) =>
      createApproval(state, {
        action: "connector.request",
        target: "demo",
        risk: "low",
        reason: "test connect",
        payload: {
          provider: "demo",
          providerLabel: "Demo",
          providerDescription: "Demo provider",
          reason: "test connect",
          fields: [],
          toolCallId: "call_demo_1"
        }
      })
    );

    const response = await call(handler, config, `/api/approvals/${approval.id}/connect`, {
      method: "POST",
      body: JSON.stringify({ secrets: {}, scopes: [] })
    });
    expect(response.ok).toBe(true);
    expect(response.connector.provider).toBe("demo");
    expect(response.connector.health).toBe("healthy");

    const state = readState(config.instance);
    const resolved = state.approvals.find((a) => a.id === approval.id);
    expect(resolved?.status).toBe("approved");
    expect(state.connectors.some((c) => c.provider === "demo" && c.health === "healthy")).toBe(true);
  });

  test("POST /api/approvals/<id>/connect returns ok:false and leaves the approval pending on probe failure", async () => {
    const config = testConfig("approvals-connect-probe-fail");
    const handler = createHandler(config);
    const { createApproval } = await import("./state");
    const approval = await mutateState(config.instance, (state) =>
      createApproval(state, {
        action: "connector.request",
        target: "linear",
        risk: "low",
        reason: "fetch issues",
        payload: {
          provider: "linear",
          providerLabel: "Linear",
          providerDescription: "Linear",
          reason: "fetch issues",
          fields: [],
          toolCallId: "call_linear_fail"
        }
      })
    );
    // Stub the Linear GraphQL probe with a 401 so the probe fails.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{\"errors\":[{\"message\":\"Unauthorized\"}]}", {
      status: 401,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
    try {
      const response = await call(handler, config, `/api/approvals/${approval.id}/connect`, {
        method: "POST",
        body: JSON.stringify({ secrets: { token: "not-a-real-token" } })
      });
      expect(response.ok).toBe(false);
      expect(response.message).toBeString();
    } finally {
      globalThis.fetch = originalFetch;
    }
    const state = readState(config.instance);
    const after = state.approvals.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });

  test("POST /api/approvals/<id>/connect rejects approvals whose action is not connector.request", async () => {
    const config = testConfig("approvals-connect-wrong-action");
    const handler = createHandler(config);
    const { createApproval } = await import("./state");
    const approval = await mutateState(config.instance, (state) =>
      createApproval(state, {
        action: "file.write",
        target: "/tmp/x",
        risk: "high",
        reason: "stub",
        payload: { path: "/tmp/x", content: "hi" }
      })
    );
    const response = await rawCall(
      handler,
      config,
      `/api/approvals/${approval.id}/connect`,
      { method: "POST", body: JSON.stringify({ secrets: {} }) },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("does not take a /connect submission");
  });

  test("POST /api/approvals/<id>/approve refuses browser.fill_secret action", async () => {
    // The generic /approve route would flip status=approved and trigger
    // runApprovedAction's browser.fill_secret branch, which synthesizes a
    // "fields filled" tool result for the agent even though no DOM fill
    // ever happened (the side effect lives inside /connect's per-slot
    // loop). Refuse early so the only resolution path for fill_secret is
    // /connect with values.
    const config = testConfig("approve-refuses-fill-secret");
    const handler = createHandler(config);
    const { createApproval } = await import("./state");
    const approval = await mutateState(config.instance, (state) =>
      createApproval(state, {
        action: "browser.fill_secret",
        target: "https://example.com/login#@e1,@e2",
        risk: "high",
        reason: "Sign in to the test site",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill"
        }
      })
    );
    const response = await rawCall(
      handler,
      config,
      `/api/approvals/${approval.id}/approve`,
      { method: "POST" },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("/connect");
    expect(body.error).toContain("not /approve");
    const after = readState(config.instance).approvals.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });

  test("POST /api/approvals/<id>/connect refuses partial browser.fill_secret submissions", async () => {
    // fillReady in BlockApprovalRequested.tsx only disables the web
    // Submit button; CLI / mobile / direct API clients can still POST a
    // partial body. The gateway must enforce that every declared slot
    // has a non-empty value before any DOM fill happens — otherwise
    // /connect would resolve with some slots silently unfilled and the
    // agent would be told (in agent.ts:runApprovedAction) that every
    // declared slot was filled.
    const config = testConfig("connect-rejects-partial-fill-secret");
    const handler = createHandler(config);
    const { createApproval } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const { createTask, upsertTask } = require("./state") as typeof import("./state");
      const task = createTask(state.instance, "partial-test");
      upsertTask(state, task);
      return task.id;
    });
    // Seed approvedUrl so the origin guard's "no live page" refusal
    // doesn't fire before the missing-slot check; this test is about
    // partial submission, not origin binding.
    const approval = await mutateState(config.instance, (state) =>
      createApproval(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        risk: "high",
        reason: "Sign in to the test site",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          // Origin only — sanitizeUrlForAuditTarget strips pathname.
          approvedUrl: "https://example.com"
        }
      })
    );
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSessionWithPageForTest(taskId, {
      // The live URL can be on any path within the approved origin;
      // the equality check is on origin only after the SEC-C fix.
      url: () => "https://example.com/login",
      close: () => Promise.resolve()
    } as Partial<import("playwright-core").Page>);
    const response = await rawCall(
      handler,
      config,
      `/api/approvals/${approval.id}/connect`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { username: "tomsmith" } })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("password");
    expect(body.message).toContain("Missing");
    const after = readState(config.instance).approvals.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });

  test("POST /api/approvals/<id>/connect: submitted fill_secret values never appear in state.json, trace JSONL, or runtime.jsonl", async () => {
    // End-to-end absence pin for the ADR's secret-handling guarantee:
    // submitted credential values must flow request-scope only and
    // never reach any persisted artifact. Without this test the only
    // protection is manual code review of every audit/trace/log write
    // touching the fill_secret path. Distinct marker strings let us
    // grep the raw bytes after the request — partial matches would
    // catch even an attempt to serialize a wrapper object containing
    // the value.
    const config = testConfig("fill-secret-no-state-leak");
    const handler = createHandler(config);
    const { createTask, upsertTask, createApproval } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "fill secret leak guard");
      upsertTask(state, task);
      return task.id;
    });
    // Seed approvedUrl on the payload AND install a matching fake
    // session so the origin guard passes and the fill loop actually
    // runs. The fills will error per-slot because the fake page's
    // .locator() returns nothing useful — what we care about is that
    // the audit row is written with redacted: true and the markers
    // never reach state/trace/log even when the runtime tries to
    // record what happened.
    const approval = await mutateState(config.instance, (state) =>
      createApproval(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        risk: "high",
        reason: "Sign in to the test site",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          approvedUrl: "https://example.com"
        }
      })
    );
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://example.com/login",
      // Fake locator that no-ops on fill; the audit-row write still
      // happens regardless of whether the fill succeeded. Cast as
      // Partial<Page> since the fake only implements what
      // browserFillByLocator touches.
      locator: ((_sel: string) => ({
        fill: async () => { throw new Error("fake session, no real DOM"); }
      })) as unknown as import("playwright-core").Page["locator"],
      close: () => Promise.resolve()
    } as Partial<import("playwright-core").Page>);
    const USERNAME_MARKER = "tomsmith-LEAK-MARKER-zzzzz";
    const PASSWORD_MARKER = "SuperSecretPassword-LEAK-MARKER-zzzzz";
    await rawCall(
      handler,
      config,
      `/api/approvals/${approval.id}/connect`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { username: USERNAME_MARKER, password: PASSWORD_MARKER } })
      },
      config.token
    );
    // No browser session exists, so browserFillByLocator returns
    // errors for both slots and the audit row evidence carries
    // `errors[]` (no values) + filledSlots = []. The approval is
    // still resolved atomically before the fill loop so the deny
    // race is closed; the agent gets a partial-fill error result
    // via resumeChatTask.

    // Raw state.json bytes must not contain either marker.
    const stateJsonPath = `${config.stateRoot}/state.json`;
    const rawState = readFileSync(stateJsonPath, "utf8");
    expect(rawState).not.toContain(USERNAME_MARKER);
    expect(rawState).not.toContain(PASSWORD_MARKER);

    // Trace JSONL (per-task) must not contain either marker. The
    // file may not exist if no trace events fired for this task —
    // an empty file is fine, the test only fails on a leak.
    const traceJsonlPath = `${config.stateRoot}/traces/${taskId}.jsonl`;
    if (existsSync(traceJsonlPath)) {
      const rawTrace = readFileSync(traceJsonlPath, "utf8");
      expect(rawTrace).not.toContain(USERNAME_MARKER);
      expect(rawTrace).not.toContain(PASSWORD_MARKER);
    }

    // runtime.jsonl is the cross-task log file — also greppable.
    const runtimeLogPath = `${config.logRoot}/runtime.jsonl`;
    if (existsSync(runtimeLogPath)) {
      const rawLog = readFileSync(runtimeLogPath, "utf8");
      expect(rawLog).not.toContain(USERNAME_MARKER);
      expect(rawLog).not.toContain(PASSWORD_MARKER);
    }

    // The audit row itself: defense-in-depth. Both `evidence` (would
    // be undefined after redaction) and `target` must not contain
    // the markers. `target` is preserved across redaction; this pin
    // catches a future regression that would forget to sanitize URL
    // query strings or stuff secrets into the target field.
    const auditRows = readState(config.instance).audit.filter(
      (a) => a.action === "browser.fill_secret" && a.approvalId === approval.id
    );
    expect(auditRows.length).toBe(1);
    const row = auditRows[0]!;
    expect(row.redacted).toBe(true);
    expect(row.evidence).toBeUndefined();
    expect(row.target ?? "").not.toContain(USERNAME_MARKER);
    expect(row.target ?? "").not.toContain(PASSWORD_MARKER);
  });

  test("POST /api/approvals/<id>/connect refuses fill_secret when page navigated away from approved origin", async () => {
    // The approval.target encodes the origin the user consented
    // to fill into (protocol+host+port; pathname is stripped by
    // sanitizeUrlForAuditTarget). If the page has navigated to a
    // different origin (agent action, user click, JS redirect,
    // phishing redirect) between approval creation and Submit,
    // the live URL no longer matches and we refuse with 409 so a
    // fresh approval is required for the new destination. In
    // this test the browser session was never opened so
    // peekCurrentBrowserUrl returns undefined,
    // which the handler treats as "no live page to fill" — same
    // refusal path.
    const config = testConfig("connect-fill-secret-origin-mismatch");
    const handler = createHandler(config);
    const { createTask, upsertTask, createApproval } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "test");
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createApproval(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        risk: "high",
        reason: "Sign in",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          // The /connect origin guard reads from the structural
          // approvedUrl on payload — peer approval actions carry
          // their contract fields under payload too. Stored as
          // origin only (no pathname) since reset/magic-link
          // URLs can carry tokens in the path.
          approvedUrl: "https://example.com"
        }
      })
    );
    const response = await rawCall(
      handler,
      config,
      `/api/approvals/${approval.id}/connect`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { username: "tomsmith", password: "SuperSecretPassword!" } })
      },
      config.token
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    // The browser session was never opened, so peekCurrentBrowserUrl
    // returns undefined and the /connect handler takes the
    // "session expired" branch (distinct from the "page navigated"
    // branch where a live session exists but its URL differs from
    // approvedUrl). Without that split the operator would see
    // "page navigated" after a 5-minute walk-away — misleading.
    expect(body.message).toContain("Browser session expired");
    expect(body.message).toContain("https://example.com");
    // Approval stayed pending — no resolveApproval call ran.
    const after = readState(config.instance).approvals.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });

  test("POST /api/approvals/<id>/connect refuses fill_secret slot values shorter than 4 chars", async () => {
    // The snapshot post-redactor uses literal substring replacement;
    // single-character (and other very short) values would shred
    // structural tokens like [@e1] in snapshot text. The 4-char
    // floor in src/tools/browser.ts:recordFilledSecret keeps the
    // redactor safe, and /connect refuses values below that floor
    // so the registry-skip-for-short-values doesn't leak the
    // value via subsequent unredacted tool results.
    const config = testConfig("connect-fill-secret-too-short");
    const handler = createHandler(config);
    const { createTask, upsertTask, createApproval } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "short value test");
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createApproval(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        risk: "high",
        reason: "Sign in",
        payload: {
          slots: [
            { name: "pin", locator: "@e1", label: "PIN", kind: "number" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          approvedUrl: "https://example.com"
        }
      })
    );
    const { __test: browserTest } = await import("./tools/browser");
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://example.com",
      close: () => Promise.resolve()
    } as Partial<import("playwright-core").Page>);
    const response = await rawCall(
      handler,
      config,
      `/api/approvals/${approval.id}/connect`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { pin: "12" } })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("too short");
    expect(body.message).toContain("pin");
    const after = readState(config.instance).approvals.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });

  test("POST /api/approvals/<id>/connect: distinct 409 when live session exists but page navigated to a different origin", async () => {
    // Pin the OTHER 409 branch: a live session whose current URL no
    // longer matches the approved origin. This is the genuine
    // page-navigated case (agent click, JS redirect, phishing
    // redirect), distinct from the session-expired idle-sweep case
    // covered by the previous test.
    const config = testConfig("connect-fill-secret-real-navigation");
    const handler = createHandler(config);
    const { createTask, upsertTask, createApproval } = await import("./state");
    const taskId = await mutateState(config.instance, (state) => {
      const task = createTask(state.instance, "real navigation test");
      upsertTask(state, task);
      return task.id;
    });
    const approval = await mutateState(config.instance, (state) =>
      createApproval(state, {
        taskId,
        action: "browser.fill_secret",
        target: "https://example.com",
        risk: "high",
        reason: "Sign in",
        payload: {
          slots: [
            { name: "username", locator: "@e1", label: "Username", kind: "text" },
            { name: "password", locator: "@e2", label: "Password", kind: "password" }
          ],
          reason: "Sign in",
          toolCallId: "call_fill",
          approvedUrl: "https://example.com"
        }
      })
    );
    const { __test: browserTest } = await import("./tools/browser");
    // Live session exists but the page URL is on a different origin
    // than what the approval captured — should take the "page
    // navigated" branch, NOT the "session expired" branch.
    browserTest.installFakeSessionWithPageForTest(taskId, {
      url: () => "https://evil.example.org/phishing",
      close: () => Promise.resolve()
    } as Partial<import("playwright-core").Page>);
    const response = await rawCall(
      handler,
      config,
      `/api/approvals/${approval.id}/connect`,
      {
        method: "POST",
        body: JSON.stringify({ secrets: { username: "tomsmith", password: "SuperSecretPassword!" } })
      },
      config.token
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.message).toContain("Page navigated");
    expect(body.message).toContain("https://example.com");
    expect(body.message).toContain("https://evil.example.org");
    const after = readState(config.instance).approvals.find((a) => a.id === approval.id);
    expect(after?.status).toBe("pending");
  });

  // Round-1 review fix: browser-connect throws with prefixes that the
  // gateway's catch-all previously mapped to 500. The webapp needs them as
  // 4xx so it can render the original message instead of "internal error".
  test("browser connect returns 400 for unsupported cdpUrl protocol", async () => {
    const config = testConfig("browser-bad-proto");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/browser/connect",
      {
        method: "POST",
        body: JSON.stringify({ cdpUrl: "file:///etc/passwd" })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Unsupported/);
  });

  test("browser connect returns 400 for garbage cdpUrl", async () => {
    const config = testConfig("browser-bad-url");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/browser/connect",
      {
        method: "POST",
        body: JSON.stringify({ cdpUrl: "not-a-url" })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Invalid cdpUrl/);
  });

  test("PATCH /api/settings/auto-approve rejects out-of-union approvalMode with 400", async () => {
    // An invalid value previously mapped to undefined and the PATCH
    // silently no-op'd while returning 200 — the client thought it
    // succeeded. Mirror job-level strict validation at the HTTP
    // boundary so misconfigured clients get a loud failure.
    const config = testConfig("settings-bad-approval-mode");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/settings/auto-approve",
      {
        method: "PATCH",
        body: JSON.stringify({ approvalMode: "bogus" })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/approvalMode must be one of/);
    expect(body.validValues).toEqual(["strict", "auto", "yolo"]);
    // Original value on the config object must not have changed.
    expect(config.approvalMode).toBe("strict");
  });

  test("POST /api/browser/wipe-profile is no longer routed", async () => {
    const config = testConfig("browser-wipe-removed");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/browser/wipe-profile",
      { method: "POST" },
      config.token
    );
    expect(response.status).toBe(404);
  });

  test("browser connect returns 400 when CDP endpoint is unreachable", async () => {
    const config = testConfig("browser-unreachable");
    const handler = createHandler(config);
    // Port 1 is reserved; probe will time out. The point of this test is
    // the status mapping, so use a short-lived test by aborting once we
    // see the response.
    const response = await rawCall(
      handler,
      config,
      "/api/browser/connect",
      {
        method: "POST",
        body: JSON.stringify({ cdpUrl: "http://127.0.0.1:1/" })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Could not reach CDP endpoint/);
  }, 30_000);

  test("stamps the active agent on records and filters listings by agentId", async () => {
    const config = testConfig("records-agentid");
    const handler = createHandler(config);

    // Two agents — submit a task under each so we have heterogeneous rows.
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });

    // Task under the default agent. We use `read README.md` so runTask
    // dispatches a real low-risk file tool and the task lands in a terminal
    // state before the test ends — avoids a background failTask firing
    // after the test's state file has been cleaned up by the next test.
    config.workspaceRoot = process.cwd();
    const defaultTask = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "read README.md" })
    });
    expect(defaultTask.agentId).toBe(defaultAgentId);
    await waitForTask(handler, config, defaultTask.id);

    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const scoutTask = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "read README.md" })
    });
    expect(scoutTask.agentId).toBe(second.id);
    await waitForTask(handler, config, scoutTask.id);

    // Unfiltered listing includes both rows.
    const all = await call(handler, config, "/api/tasks");
    expect(all.some((task: { id: string }) => task.id === defaultTask.id)).toBe(true);
    expect(all.some((task: { id: string }) => task.id === scoutTask.id)).toBe(true);

    // Filtered listing returns only the matching agent's rows.
    const scoutOnly = await call(handler, config, `/api/tasks?agentId=${encodeURIComponent(second.id)}`);
    expect(scoutOnly.every((task: { agentId?: string }) => task.agentId === second.id)).toBe(true);
    expect(scoutOnly.some((task: { id: string }) => task.id === scoutTask.id)).toBe(true);
    expect(scoutOnly.some((task: { id: string }) => task.id === defaultTask.id)).toBe(false);

    // Empty string is treated as "no filter" — preserves legacy behavior.
    const empty = await call(handler, config, "/api/tasks?agentId=");
    expect(empty.length).toBe(all.length);
  });

  test("stamps the active agent on chat sessions and filters by agentId", async () => {
    const config = testConfig("records-agentid-chat");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const sessionA = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "under default" })
    });
    expect(sessionA.agentId).toBe(defaultAgentId);
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const sessionB = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "under scout" })
    });
    expect(sessionB.agentId).toBe(second.id);
    const scopedDefault = await call(handler, config, `/api/chat?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(scopedDefault.some((s: { id: string }) => s.id === sessionA.id)).toBe(true);
    expect(scopedDefault.some((s: { id: string }) => s.id === sessionB.id)).toBe(false);
    const scopedScout = await call(handler, config, `/api/chat?agentId=${encodeURIComponent(second.id)}`);
    expect(scopedScout.some((s: { id: string }) => s.id === sessionB.id)).toBe(true);
    expect(scopedScout.some((s: { id: string }) => s.id === sessionA.id)).toBe(false);
  });

  test("stamps the active agent on jobs and filters job listings", async () => {
    const config = testConfig("records-agentid-jobs");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const jobA = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "default-job", prompt: "hello", intervalSeconds: 3600 })
    });
    expect(jobA.agentId).toBe(defaultAgentId);
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const jobB = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "scout-job", prompt: "hi", intervalSeconds: 3600 })
    });
    expect(jobB.agentId).toBe(second.id);
    const scoped = await call(handler, config, `/api/jobs?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(scoped.every((j: { agentId?: string }) => j.agentId === defaultAgentId)).toBe(true);
    expect(scoped.some((j: { id: string }) => j.id === jobA.id)).toBe(true);
    expect(scoped.some((j: { id: string }) => j.id === jobB.id)).toBe(false);
  });

  test("stamps the active agent on subagents and filters by agentId", async () => {
    const config = testConfig("records-agentid-subagents");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const subA = await call(handler, config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({ name: "child-default", prompt: "report" })
    });
    expect(subA.agentId).toBe(defaultAgentId);
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const subB = await call(handler, config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({ name: "child-scout", prompt: "report" })
    });
    expect(subB.agentId).toBe(second.id);
    const scoped = await call(handler, config, `/api/subagents?agentId=${encodeURIComponent(second.id)}`);
    expect(scoped.every((s: { agentId?: string }) => s.agentId === second.id)).toBe(true);
    expect(scoped.some((s: { id: string }) => s.id === subB.id)).toBe(true);
    expect(scoped.some((s: { id: string }) => s.id === subA.id)).toBe(false);
  });

  test("subagent inherits the parent task's agent even when the active agent switched", async () => {
    const config = testConfig("records-agentid-subagent-inherit");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Submit a parent task under the default agent so the resulting parent
    // task carries agentId=default.
    const parentTask = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "echo parent" })
    });
    await waitForTask(handler, config, parentTask.id);
    // Switch the active agent *before* spawning the subagent. The child
    // should still inherit the parent's agent id (default), not the active
    // agent (scout). Regression test for the inheritance bug where
    // spawnSubagent read `resolveEffectiveContext(...).agentId` directly.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const child = await call(handler, config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({
        name: "child",
        prompt: "echo child",
        parentTaskId: parentTask.id
      })
    });
    expect(child.agentId).toBe(defaultAgentId);
    // The child task spawned by the subagent path should also carry the
    // parent's agent — not the active agent at the moment of spawn.
    await waitForTask(handler, config, child.taskId);
    const childDetail = await call(handler, config, `/api/tasks/${child.taskId}`);
    expect(childDetail.task.agentId).toBe(defaultAgentId);
  });

  test("approvals inherit agentId from the originating task and filter by agentId", async () => {
    const config = testConfig("records-agentid-approvals");
    // The patch flow writes through workspaceRoot; point at the repo so the
    // pre-image read in `patch README.md ::` succeeds.
    config.workspaceRoot = process.cwd();
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Submit a patch task under the default agent — the agent loop blocks
    // on file.patch until approval, and createApproval inherits agentId
    // from the originating task.
    const task = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "patch README.md :: Gini => Gini" })
    });
    await waitForTask(handler, config, task.id);
    // Switch the active agent *before* asserting. The approval was already
    // created under the originating task, so it must carry the default
    // agent's id regardless of whoever is active now.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const approvals = readState(config.instance).approvals.filter((a) => a.taskId === task.id);
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every((a) => a.agentId === defaultAgentId)).toBe(true);
    const scopedDefault = await call(handler, config, `/api/approvals?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(scopedDefault.every((a: { agentId?: string }) => a.agentId === defaultAgentId)).toBe(true);
    expect(scopedDefault.some((a: { taskId?: string }) => a.taskId === task.id)).toBe(true);
    const scopedScout = await call(handler, config, `/api/approvals?agentId=${encodeURIComponent(second.id)}`);
    expect(scopedScout.some((a: { taskId?: string }) => a.taskId === task.id)).toBe(false);
  });

  test("stamps the active agent on events and audit and filters listings", async () => {
    const config = testConfig("records-agentid-events");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // The agent.activated audit/event for the second agent should be tagged
    // with its id — the runtime stamps the active agent via inferAgentId.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const events = await call(handler, config, `/api/events?agentId=${encodeURIComponent(second.id)}`);
    expect(events.every((e: { agentId?: string }) => e.agentId === second.id)).toBe(true);
    expect(events.some((e: { action: string }) => e.action === "agent.activated")).toBe(true);
    const defaultEvents = await call(handler, config, `/api/events?agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(defaultEvents.every((e: { agentId?: string }) => e.agentId === defaultAgentId)).toBe(true);
    const audit = await call(handler, config, `/api/audit?agentId=${encodeURIComponent(second.id)}`);
    expect(audit.every((a: { agentId?: string }) => a.agentId === second.id)).toBe(true);
  });

  test("migrateRecordAgentIds is idempotent across repeated reads", async () => {
    const config = testConfig("records-agentid-idempotent");
    const handler = createHandler(config);
    // Seed an unstamped task to force a backfill on the first read.
    await mutateState(config.instance, (state) => {
      state.tasks.unshift({
        id: "task_legacy_one",
        title: "legacy",
        input: "legacy task",
        status: "completed",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: []
      });
    });
    // Trigger reads to run normalizeState multiple times.
    await call(handler, config, "/api/tasks");
    await call(handler, config, "/api/tasks");
    await call(handler, config, "/api/tasks");
    const audit = await call(handler, config, "/api/audit");
    const backfills = audit.filter((row: { action: string }) => row.action === "records.agentid.backfill");
    // Exactly one backfill row should exist regardless of how many reads.
    expect(backfills.length).toBe(1);
  });

  test("scheduled job fired after agent switch attributes the task to the originating agent", async () => {
    const config = testConfig("records-agentid-job-fire");
    const handler = createHandler(config);
    config.workspaceRoot = process.cwd();
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Create the job under the default agent. Use a read tool so the
    // spawned task can settle into a terminal state inside the test window
    // — keeps the runtime from logging a "Task not found" against a stale
    // state file after the next test cleans up.
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "owner-test", prompt: "read README.md", intervalSeconds: 3600 })
    });
    expect(job.agentId).toBe(defaultAgentId);
    // Switch the active agent *before* the job fires.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    // Fire the job manually (the dispatch path is shared with the scheduler).
    const fired = await call(handler, config, `/api/jobs/${job.id}/run`, { method: "POST" });
    expect(fired.taskId).toBeString();
    // Wait for the resulting task to settle so its async tail doesn't
    // outlive the test and trip a "Task not found" failure on a later
    // test's state-file cleanup.
    await waitForTask(handler, config, fired.taskId);
    const detail = await call(handler, config, `/api/tasks/${fired.taskId}`);
    expect(detail.task.agentId).toBe(defaultAgentId);
    expect(detail.task.jobId).toBe(job.id);
  });

  test("POST /api/jobs ignores agentId in the request body", async () => {
    // Regression: the public input bag previously honored a caller-supplied
    // `agentId`, letting a malicious or buggy client attribute new jobs to
    // any agent. Now the HTTP path strips it and the runtime falls back to
    // the active agent.
    const config = testConfig("records-agentid-job-untrusted-input");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // While the active agent is still the default, post a job whose body
    // tries to spoof attribution to the scout agent.
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "spoof-job",
        prompt: "hello",
        intervalSeconds: 3600,
        agentId: second.id
      })
    });
    expect(job.agentId).toBe(defaultAgentId);
    expect(job.agentId).not.toBe(second.id);
  });

  test("job lifecycle audits carry the originating job's agent across a switch", async () => {
    // Regression: addAudit's inferAgentId previously had no jobId fallback
    // and the lifecycle audit writes in src/jobs/index.ts didn't pass
    // agentId, so a paused/updated/removed audit after an agent switch
    // misattributed the row to the new active agent.
    const config = testConfig("records-agentid-job-audits");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "audit-job", prompt: "hello", intervalSeconds: 3600 })
    });
    expect(job.agentId).toBe(defaultAgentId);
    // Switch the active agent *before* exercising the lifecycle transitions.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    await call(handler, config, `/api/jobs/${job.id}/pause`, { method: "POST" });
    await call(handler, config, `/api/jobs/${job.id}/resume`, { method: "POST" });
    await call(handler, config, `/api/jobs/${job.id}`, {
      method: "PATCH",
      body: JSON.stringify({ intervalSeconds: 7200 })
    });
    await call(handler, config, `/api/jobs/${job.id}`, { method: "DELETE" });
    const state = readState(config.instance);
    const targeted = state.audit.filter((a) => a.target === job.id);
    const lifecycle = targeted.filter((a) =>
      a.action === "job.paused"
      || a.action === "job.active"
      || a.action === "job.updated"
      || a.action === "job.removed"
    );
    expect(lifecycle.length).toBeGreaterThanOrEqual(4);
    expect(lifecycle.every((a) => a.agentId === defaultAgentId)).toBe(true);
  });

  test("chat message under a session keeps the session's agent across all emitted events", async () => {
    // Regression: createRun and createPlanStep previously emitted events
    // without an agentId. With the session bound to agent A, sending a
    // message after switching the active agent to B would mis-stamp the
    // run/step events to B even though the task itself inherits A.
    const config = testConfig("records-agentid-chat-message");
    config.workspaceRoot = process.cwd();
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "owned by default" })
    });
    expect(session.agentId).toBe(defaultAgentId);
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "read README.md" })
    });
    await waitForTask(handler, config, submitted.taskId);
    const task = (await call(handler, config, `/api/tasks/${submitted.taskId}`)).task;
    expect(task.agentId).toBe(defaultAgentId);
    // Every event for this run should carry the original session's agent —
    // not the now-active scout agent.
    const state = readState(config.instance);
    const runEvents = state.events.filter((e) => e.runId === submitted.runId);
    expect(runEvents.length).toBeGreaterThan(0);
    expect(runEvents.every((e) => e.agentId === defaultAgentId)).toBe(true);
    // The run.created and run.step.created events should specifically be
    // present and tagged.
    expect(runEvents.some((e) => e.action === "run.created")).toBe(true);
    expect(runEvents.some((e) => e.action === "run.step.created")).toBe(true);
  });

  test("chat session lifecycle events carry the session's agent", async () => {
    // Regression: createChatSession / deleteChatSession / renameChatSession
    // emitted lifecycle events without an agentId. A session created /
    // renamed / deleted while a different agent was active would attribute
    // the event to the active agent rather than the session's owner.
    const config = testConfig("records-agentid-chat-lifecycle");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Create the session under default.
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "lifecycle" })
    });
    expect(session.agentId).toBe(defaultAgentId);
    // Switch active to scout, then rename and delete the default-owned
    // session — both events should still carry the default's id.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    await call(handler, config, `/api/chat/${session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "renamed" })
    });
    await call(handler, config, `/api/chat/${session.id}`, { method: "DELETE" });
    const state = readState(config.instance);
    const targeted = state.events.filter((e) => e.target === session.id);
    const created = targeted.find((e) => e.action === "chat.session.created");
    const renamed = targeted.find((e) => e.action === "chat.session.renamed");
    const deleted = targeted.find((e) => e.action === "chat.session.deleted");
    expect(created?.agentId).toBe(defaultAgentId);
    expect(renamed?.agentId).toBe(defaultAgentId);
    expect(deleted?.agentId).toBe(defaultAgentId);
  });

  test("deleting a chat session also clears the per-conversation identity snapshot", async () => {
    // Identity snapshots are keyed on conversationId (the chat session id);
    // without the cleanup in deleteChatSession each deleted chat leaks one
    // IdentitySnapshotRecord into state forever.
    const config = testConfig("records-identity-snapshot-cleanup");
    const handler = createHandler(config);
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "snapshot-cleanup" })
    });
    await mutateState(config.instance, (state) => {
      if (!state.identitySnapshots) state.identitySnapshots = {};
      state.identitySnapshots[session.id] = {
        identity: {
          instance: config.instance,
          runtimePort: config.port,
          agentName: "default",
          agentId: "agent_x",
          provider: "echo/test",
          toolsets: ["file"],
          memoryNamespace: "agent_x"
        },
        lastFullTurn: 1
      };
    });
    expect(readState(config.instance).identitySnapshots?.[session.id]).toBeDefined();
    await call(handler, config, `/api/chat/${session.id}`, { method: "DELETE" });
    expect(readState(config.instance).identitySnapshots?.[session.id]).toBeUndefined();
  });

  test("addAudit infers agentId from jobId when neither agentId nor taskId is provided", async () => {
    // Regression: inferAgentId's jobId fallback only fires when the caller
    // threads `jobId` (or appendEvent's persisted `jobId`) through. This
    // test pins that an audit row created with just jobId resolves to the
    // owning job's agent — without it the row would fall back to
    // state.activeAgentId after a switch.
    const config = testConfig("records-agentid-job-fallback");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "fallback-job", prompt: "hi", intervalSeconds: 3600 })
    });
    // Switch the active agent before emitting the audit.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    await mutateState(config.instance, (state) => {
      addAudit(
        state,
        {
          actor: "runtime",
          action: "test.job.fallback",
          target: job.id,
          risk: "low",
          evidence: { jobId: job.id }
        },
        { jobId: job.id }
      );
    });
    const state = readState(config.instance);
    const audit = state.audit.find((a) => a.action === "test.job.fallback");
    expect(audit?.agentId).toBe(defaultAgentId);
    const paired = state.events.find((e) => e.action === "test.job.fallback");
    expect(paired?.agentId).toBe(defaultAgentId);
  });

  test("migrateRecordAgentIds re-stamps rows pointing at a deleted agent", async () => {
    // Regression: the migration's predicate previously only re-stamped
    // rows where agentId was missing. A row carrying the id of a deleted
    // agent stayed stranded under an unselectable bucket. Now stale ids
    // are treated the same as missing.
    const config = testConfig("records-agentid-stale");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    // Seed records pointing at a ghost agent that doesn't exist in
    // state.agents. The next read triggers normalizeState ->
    // migrateRecordAgentIds and should re-stamp them with the first
    // existing agent (the default).
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      state.tasks.unshift({
        id: "task_ghost",
        title: "ghost",
        input: "ghost task",
        status: "completed",
        instance: state.instance,
        agentId: "agent_ghost",
        createdAt: at,
        updatedAt: at,
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: []
      });
    });
    // Trigger the migration via a fresh read.
    await call(handler, config, "/api/tasks");
    const stamped = readState(config.instance);
    const ghostTask = stamped.tasks.find((t) => t.id === "task_ghost");
    expect(ghostTask?.agentId).toBe(defaultAgentId);
    // Re-reading should be idempotent — no further backfill row beyond
    // what the first migration produced.
    await call(handler, config, "/api/tasks");
    await call(handler, config, "/api/tasks");
    const audit = await call(handler, config, "/api/audit");
    const backfills = audit.filter((row: { action: string }) => row.action === "records.agentid.backfill");
    expect(backfills.length).toBe(1);
  });

  test("AgentContext resolves each source-id branch deterministically", async () => {
    // Pin the AgentContext contract: each branch in the union resolves to
    // the agent its source record carries, never to state.activeAgentId.
    // We exercise every branch from a single test instance so the
    // resolution matrix lives in one place.
    const config = testConfig("agent-context-branches");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });
    // Seed a task, job, session, and memory under the default agent.
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "branch-test" })
    });
    const job = await call(handler, config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name: "branch-job", prompt: "hi", intervalSeconds: 3600 })
    });
    await mutateState(config.instance, (state) => {
      state.tasks.unshift({
        id: "task_branch",
        title: "branch",
        input: "branch task",
        status: "completed",
        instance: state.instance,
        agentId: defaultAgentId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: []
      });
    });
    // Switch the active agent so any silent fallback would attribute to
    // scout rather than the source record's owner.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    await mutateState(config.instance, (state) => {
      // explicit agentId branch
      addAudit(
        state,
        { actor: "runtime", action: "test.branch.agentId", target: "explicit", risk: "low" },
        { agentId: defaultAgentId }
      );
      // taskId branch
      addAudit(
        state,
        { actor: "runtime", action: "test.branch.taskId", target: "from-task", risk: "low" },
        { taskId: "task_branch" }
      );
      // jobId branch
      addAudit(
        state,
        { actor: "runtime", action: "test.branch.jobId", target: "from-job", risk: "low" },
        { jobId: job.id }
      );
      // sessionId branch
      addAudit(
        state,
        { actor: "runtime", action: "test.branch.sessionId", target: "from-session", risk: "low" },
        { sessionId: session.id }
      );
      // system: true branch
      addAudit(
        state,
        { actor: "runtime", action: "test.branch.system", target: "system", risk: "low" },
        { system: true }
      );
    });
    const audit = readState(config.instance).audit;
    expect(audit.find((a) => a.action === "test.branch.agentId")?.agentId).toBe(defaultAgentId);
    expect(audit.find((a) => a.action === "test.branch.taskId")?.agentId).toBe(defaultAgentId);
    expect(audit.find((a) => a.action === "test.branch.jobId")?.agentId).toBe(defaultAgentId);
    expect(audit.find((a) => a.action === "test.branch.sessionId")?.agentId).toBe(defaultAgentId);
    expect(audit.find((a) => a.action === "test.branch.system")?.agentId).toBeUndefined();
  });

  test("AgentContext is required at the type level for every emitter", () => {
    // Pin the type-level invariant: calling appendEvent or addAudit
    // without an AgentContext is a compile error, not a silent
    // active-agent fallback. The `@ts-expect-error` directives below
    // force tsc to confirm the missing third argument is rejected.
    // If these comments stop catching an error, someone reintroduced a
    // two-argument overload and the whole point of this refactor is
    // undone.
    //
    // We never actually invoke these — the type check is the assertion.
    // Wrapping in a `false &&` keeps tsc inspecting the call signature
    // while keeping the runtime tree-shake-eligible.
    if (false as boolean) {
      const state = readState("agent-context-typecheck");
      // @ts-expect-error appendEvent requires an AgentContext as the third argument.
      appendEvent(state, { kind: "runtime", action: "no-context", target: "x", risk: "low", summary: "x" });
      // @ts-expect-error addAudit requires an AgentContext as the third argument.
      addAudit(state, { actor: "runtime", action: "no-context", target: "x", risk: "low" });
    }
    expect(true).toBe(true);
  });

  test("AgentContext returns undefined when the source record was deleted", async () => {
    // The contract says: if a sourceId is provided but the record doesn't
    // exist (deleted, race), resolveAgentId returns undefined. It must NOT
    // silently fall back to the active agent.
    const config = testConfig("agent-context-missing-source");
    const handler = createHandler(config);
    await mutateState(config.instance, (state) => {
      addAudit(
        state,
        { actor: "runtime", action: "test.missing.task", target: "x", risk: "low" },
        { taskId: "task_does_not_exist" }
      );
      addAudit(
        state,
        { actor: "runtime", action: "test.missing.job", target: "x", risk: "low" },
        { jobId: "job_does_not_exist" }
      );
      addAudit(
        state,
        { actor: "runtime", action: "test.missing.session", target: "x", risk: "low" },
        { sessionId: "chat_does_not_exist" }
      );
    });
    const audit = readState(config.instance).audit;
    expect(audit.find((a) => a.action === "test.missing.task")?.agentId).toBeUndefined();
    expect(audit.find((a) => a.action === "test.missing.job")?.agentId).toBeUndefined();
    expect(audit.find((a) => a.action === "test.missing.session")?.agentId).toBeUndefined();
  });

  test("POST /api/messaging/:id/allow with a malformed chatId returns 400 (not 500)", async () => {
    // parseChatIdStrict throws "Invalid input: chatId must be ..." so
    // statusFromErrorMessage maps it to 400. Without the prefix, a
    // caller who PUTs `null` or `""` would see "internal error" 500.
    const config = testConfig("messaging-allow-bad-chatid");
    const handler = createHandler(config);
    const { addMessagingBridge } = await import("./integrations/messaging");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    const badPayloads: Array<unknown> = [null, "", "123abc", "abc", 1.5];
    for (const chatId of badPayloads) {
      const response = await rawCall(
        handler,
        config,
        `/api/messaging/${bridge.id}/allow`,
        { method: "POST", body: JSON.stringify({ chatId }) },
        config.token
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/chatId must be a finite integer/);
    }
  });

  test("POST /api/messaging/:id/allow with a mismatched verification code returns 409 (not 500)", async () => {
    // allowChat throws "Verification code mismatch — ..." when the
    // operator's UI snapshot lost a race against a fresher DM that
    // rotated the pending code. The HTTP layer must map that to 409
    // Conflict (stale-view), not the previous catch-all 500.
    const config = testConfig("messaging-allow-code-mismatch");
    const handler = createHandler(config);
    const { addMessagingBridge, recordDeniedChatAttempt } = await import("./integrations/messaging");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    await recordDeniedChatAttempt(config, bridge.id, { chatId: 42, chatType: "private" });
    const response = await rawCall(
      handler,
      config,
      `/api/messaging/${bridge.id}/allow`,
      {
        method: "POST",
        body: JSON.stringify({ chatId: 42, expectedCode: "ZZ-ZZ-ZZ" })
      },
      config.token
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/Verification code mismatch/);
  });

  test("POST /api/messaging/:id/allow with an expired verification code returns 409 (not 500)", async () => {
    // allowChat throws "Verification code for chat ${chatId} has expired
    // ..." when the pending code aged past its TTL between page load and
    // click. Same 409 contract as the mismatch case so the UI can
    // distinguish stale-view conflicts from generic server errors.
    const { mutateState } = await import("./state/store");
    const config = testConfig("messaging-allow-code-expired");
    const handler = createHandler(config);
    const { addMessagingBridge, recordDeniedChatAttempt } = await import("./integrations/messaging");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    const pending = await recordDeniedChatAttempt(config, bridge.id, {
      chatId: 99,
      chatType: "private"
    });
    expect(pending?.verificationCode).toBeTruthy();
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id);
      if (!live) return;
      const meta = { ...(live.metadata ?? {}) };
      const list = Array.isArray(meta.recentDeniedChats) ? [...meta.recentDeniedChats] : [];
      const idx = list.findIndex((entry: { chatId?: number }) => entry?.chatId === 99);
      if (idx < 0) return;
      list[idx] = {
        ...list[idx],
        verificationCodeExpiresAt: new Date(Date.now() - 60_000).toISOString()
      };
      meta.recentDeniedChats = list;
      live.metadata = meta;
    });
    const response = await rawCall(
      handler,
      config,
      `/api/messaging/${bridge.id}/allow`,
      {
        method: "POST",
        body: JSON.stringify({ chatId: 99, expectedCode: pending!.verificationCode })
      },
      config.token
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatch(/has expired/);
  });

  // ChatBlock protocol endpoints (ADR chat-block-protocol.md). The
  // routes are smoke-tested here; deeper assertions on per-block
  // shape live in src/state/chat-blocks.test.ts and
  // src/execution/chat-task.test.ts.
  test("GET /api/chat/:id/blocks returns ordered ChatBlock list and 404 for missing sessions", async () => {
    const config = testConfig("chat-blocks-list");
    const handler = createHandler(config);
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "blocks endpoint smoke" })
    });
    const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "please reply" })
    });
    await waitForTask(handler, config, submitted.taskId);

    const blocks = await call(handler, config, `/api/chat/${session.id}/blocks`);
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].kind).toBe("user_text");
    expect(blocks[0].text).toBe("please reply");
    // Ordinals monotonically increase.
    const ordinals = blocks.map((b: { ordinal: number }) => b.ordinal);
    for (let i = 1; i < ordinals.length; i += 1) {
      expect(ordinals[i]).toBeGreaterThan(ordinals[i - 1]!);
    }

    const missing = await rawCall(
      handler,
      config,
      `/api/chat/chat_does_not_exist/blocks`,
      {},
      config.token
    );
    expect(missing.status).toBe(404);
  });

  test("DELETE /api/chat/:id cascades chat blocks (subsequent /blocks returns 404)", async () => {
    const config = testConfig("chat-blocks-cascade");
    const handler = createHandler(config);
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "cascade smoke" })
    });
    await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "blocks should disappear after delete" })
    });
    // Wait for at least the user_text block to land. We don't need the
    // assistant turn to finish for this assertion.
    let blocks: unknown[] = [];
    for (let i = 0; i < 50; i += 1) {
      const result = await call(handler, config, `/api/chat/${session.id}/blocks`);
      if (Array.isArray(result) && result.length > 0) {
        blocks = result;
        break;
      }
      await Bun.sleep(20);
    }
    expect(blocks.length).toBeGreaterThan(0);

    await call(handler, config, `/api/chat/${session.id}`, { method: "DELETE" });

    const afterDelete = await rawCall(
      handler,
      config,
      `/api/chat/${session.id}/blocks`,
      {},
      config.token
    );
    expect(afterDelete.status).toBe(404);
  });

  test("GET /api/chat/:id/stream returns SSE with chat_block frames", async () => {
    const config = testConfig("chat-blocks-stream");
    const handler = createHandler(config);
    const session = await call(handler, config, "/api/chat", {
      method: "POST",
      body: JSON.stringify({ title: "stream smoke" })
    });
    // Pre-publish some blocks so the initial backfill carries data.
    const submitted = await call(handler, config, `/api/chat/${session.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "stream this" })
    });
    await waitForTask(handler, config, submitted.taskId);

    const response = await rawCall(
      handler,
      config,
      `/api/chat/${session.id}/stream`,
      {},
      config.token
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // Read just the first frame to confirm the SSE shape; if we
    // consumed the whole body we'd block on the keepalive interval.
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let buffer = "";
    if (reader) {
      // Pump up to ~500ms collecting frames so the backfill arrives.
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<{ done: boolean; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: false, value: undefined }), 50)
          )
        ]);
        if (done) break;
        if (value) buffer += decoder.decode(value);
        if (buffer.includes("user_text")) break;
      }
      await reader.cancel();
    }
    expect(buffer).toContain("event: chat_block");
    expect(buffer).toContain("user_text");
    expect(buffer).toContain("stream this");
  });

  test("GET /api/chat/:id/stream returns 404 for unknown sessions", async () => {
    const config = testConfig("chat-blocks-stream-404");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      `/api/chat/chat_unknown/stream`,
      {},
      config.token
    );
    expect(response.status).toBe(404);
  });

  test("POST /api/messaging/:id/reject-pending with a malformed chatId returns 400 (not 500)", async () => {
    // Same parseChatIdStrict guard as /allow — pin it here so the new
    // route doesn't regress to 500 on bad input as the surface grows.
    const config = testConfig("messaging-reject-pending-bad-chatid");
    const handler = createHandler(config);
    const { addMessagingBridge } = await import("./integrations/messaging");
    const bridge = await addMessagingBridge(config, {
      name: "tg",
      kind: "telegram",
      deliveryTargets: ["1"],
      botToken: "TOK"
    });
    const badPayloads: Array<unknown> = [null, "", "123abc", "abc", 1.5];
    for (const chatId of badPayloads) {
      const response = await rawCall(
        handler,
        config,
        `/api/messaging/${bridge.id}/reject-pending`,
        { method: "POST", body: JSON.stringify({ chatId }) },
        config.token
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/chatId must be a finite integer/);
    }
  });

  test("rejects /api/embedding/reembed payloads that pass both allBanks and bankId", async () => {
    // The CLI throws when both --all-banks and --bank are supplied
    // (src/cli/commands/embedding.ts). The HTTP API has to mirror
    // that contract: silently ignoring bankId when allBanks=true
    // would let a caller think they were reembedding a single bank
    // and instead trigger a full-instance reembed — a destructive,
    // irreversible operation against every bank in the instance.
    const config = testConfig("embedding-reembed-conflict");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/embedding/reembed",
      {
        method: "POST",
        body: JSON.stringify({ allBanks: true, bankId: "bank_default" })
      },
      config.token
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/mutually exclusive/);
  });

  describe("identity-files routes", () => {
    test("GET /api/identity-files returns INSTRUCTIONS.md, USER.md, and SOULs with budget metadata", async () => {
      const config = testConfig("identity-show");
      const handler = createHandler(config);
      // Seed USER.md so the budget snapshot is meaningful.
      const { writeUserProfile, scaffoldInstanceIdentityFiles } = await import("./runtime/identity-files");
      scaffoldInstanceIdentityFiles(config.instance);
      writeUserProfile(config.instance, "## Identity\n- Name: TestUser", "approved");
      const dump = await call(handler, config, "/api/identity-files");
      expect(dump.instance).toBe(config.instance);
      expect(dump.userProfile.content).toContain("Name: TestUser");
      expect(dump.userProfile.cap).toBe(1500);
      expect(dump.userProfile.budget.used).toBeGreaterThan(0);
      expect(dump.userProfile.budget.overCap).toBe(false);
      // INSTRUCTIONS.md is materialized by scaffold; the route returns
      // its content trimmed.
      expect(dump.instructions.content).toMatch(/local-first personal agent/);
    });

    test("GET /api/identity-files/history?kind=user returns snapshots newest-first", async () => {
      const config = testConfig("identity-history");
      const handler = createHandler(config);
      const { writeUserProfile } = await import("./runtime/identity-files");
      writeUserProfile(config.instance, "v1", "approved");
      writeUserProfile(config.instance, "v2", "approved");
      writeUserProfile(config.instance, "v3", "approved");
      const out = await call(handler, config, "/api/identity-files/history?kind=user");
      expect(out.kind).toBe("user");
      // Three writes → two snapshots in history (first write has nothing
      // to roll back to).
      expect(out.entries.length).toBe(2);
      // Each entry carries a path-safe name and a positive size.
      for (const entry of out.entries) {
        expect(entry.name).toMatch(/\.md$/);
        expect(entry.sizeBytes).toBeGreaterThan(0);
      }
    });

    test("POST /api/identity-files/rollback restores from a snapshot and emits an audit row", async () => {
      const config = testConfig("identity-rollback");
      const handler = createHandler(config);
      const { writeUserProfile, listUserProfileHistory, userProfilePath } = await import("./runtime/identity-files");
      writeUserProfile(config.instance, "v1 body", "approved");
      writeUserProfile(config.instance, "v2 body", "approved");
      writeUserProfile(config.instance, "v3 body", "approved");
      const history = listUserProfileHistory(config.instance);
      const v1Snap = history.find((e) => readFileSync(e.path, "utf8") === "v1 body");
      expect(v1Snap).toBeDefined();
      const result = await call(handler, config, "/api/identity-files/rollback", {
        method: "POST",
        body: JSON.stringify({ kind: "user", snapshot: v1Snap!.name })
      });
      expect(result.ok).toBe(true);
      expect(result.restoredBytes).toBe(Buffer.byteLength("v1 body", "utf8"));
      // The active USER.md now holds the rolled-back body.
      expect(readFileSync(userProfilePath(config.instance), "utf8")).toBe("v1 body");
      // Audit row recorded the rollback.
      const state = readState(config.instance);
      const audit = state.audit.find((a) => a.action === "identity.user_profile.rollback");
      expect(audit).toBeDefined();
      // Pre-rollback snapshot was created so the rollback is itself
      // reversible.
      expect(result.preRestoreSnapshot).not.toBeNull();
    });

    test("POST /api/identity-files/rollback rejects an unknown snapshot name with reason='no snapshot'", async () => {
      const config = testConfig("identity-rollback-unknown");
      const handler = createHandler(config);
      const { writeUserProfile } = await import("./runtime/identity-files");
      writeUserProfile(config.instance, "v1", "approved");
      const result = await call(handler, config, "/api/identity-files/rollback", {
        method: "POST",
        body: JSON.stringify({ kind: "user", snapshot: "2099-01-01T00-00-00.000Z.md" })
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("no snapshot");
    });
  });
});

async function call(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  return callWithToken(handler, config, config.token, path, init);
}

async function callWithToken(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, token: string, path: string, init: RequestInit = {}) {
  const response = await rawCall(handler, config, path, init, token);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function callPublic(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  const response = await rawCall(handler, config, path, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function rawCall(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}, token?: string) {
  const response = await handler(new Request(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) }
  }));
  return response;
}

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-http-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`,
    // These tests predate the approval-mode flip and rely on the
    // gated path. Force "strict" to keep them honest; new defaults
    // are exercised in approval-mode.test.ts.
    approvalMode: "strict"
  };
}

async function waitForTask(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, taskId: string) {
  // Phase 5 added auto-recall + auto-retain to runTask. The retain side is
  // fire-and-forget so it can't block, but the inline recall + a few extra
  // mutateState audits push runTask completion past the original 500ms
  // budget on slower hosts. A 200-iteration / 10ms loop = 2s ceiling is
  // still well under any reasonable test timeout.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const detail = await call(handler, config, `/api/tasks/${taskId}`);
    if (["completed", "failed", "waiting_approval"].includes(detail.task.status)) return detail;
    await Bun.sleep(10);
  }
  throw new Error(`Task did not settle: ${taskId}`);
}
