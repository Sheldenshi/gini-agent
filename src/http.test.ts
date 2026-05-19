import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createHandler } from "./http";
import { appendEvent, mutateState, readState, readTrace } from "./state";
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
        kind: "memory",
        title: "Remember review preference",
        payload: { content: "Prefer evidence-backed reviews." }
      })
    });

    const rejected = await call(handler, config, `/api/improvements/${proposal.id}/reject`, { method: "POST" });
    const state = readState(config.instance);

    expect(rejected.status).toBe("rejected");
    expect(state.memories).toHaveLength(0);
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
      body: JSON.stringify({ kind: "memory", title: "event-test", payload: { content: "events are observable" } })
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
      body: JSON.stringify({ kind: "memory", title: "first", payload: { content: "first" } })
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
        appendEvent(state, {
          kind: "runtime",
          action: "noop",
          target: `target-${i}`,
          risk: "low",
          summary: `event ${i}`
        });
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

  test("supports memory edit/archive and approval-gated file patch diffs", async () => {
    const config = testConfig("memory-patch");
    config.workspaceRoot = process.cwd();
    const handler = createHandler(config);

    const memory = await call(handler, config, "/api/memory", {
      method: "POST",
      body: JSON.stringify({ content: "original memory", status: "active" })
    });
    const edited = await call(handler, config, `/api/memory/${memory.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "edited memory" })
    });
    const archived = await call(handler, config, `/api/memory/${memory.id}`, { method: "DELETE" });

    const task = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "patch README.md :: Gini => Gini" })
    });
    const detail = await waitForTask(handler, config, task.id);
    const approval = readState(config.instance).approvals.find((item) => item.taskId === task.id);

    expect(edited.content).toBe("edited memory");
    expect(archived.status).toBe("archived");
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
      body: JSON.stringify({ kind: "memory", title: "readiness", payload: { content: "readiness evidence" } })
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

    // Task under the default agent.
    const defaultTask = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "noop" })
    });
    expect(defaultTask.agentId).toBe(defaultAgentId);

    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const scoutTask = await call(handler, config, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({ input: "noop" })
    });
    expect(scoutTask.agentId).toBe(second.id);

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
    logRoot: `${root}-logs/${instance}`
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
