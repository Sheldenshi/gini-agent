import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createHandler } from "./http";
import { readState } from "./state";
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
    const state = readState(config.lane);

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
    const state = readState(config.lane);

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

    expect(mobile.lane).toBe(config.lane);
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
    expect(readState(config.lane).audit.some((event) => event.action === "promotion.rejected")).toBe(true);
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
    const state = readState(config.lane);

    expect(readDetail.task.status).toBe("completed");
    expect(listDetail.task.summary).toContain("src/agent.ts");
    expect(findDetail.task.summary).toContain("README.md");
    expect(state.audit.some((event) => event.action === "file.read")).toBe(true);
    expect(state.audit.some((event) => event.action === "file.list")).toBe(true);
    expect(state.audit.some((event) => event.action === "file.search")).toBe(true);
  });

  test("supports profile config equivalents and Hermes parity reporting", async () => {
    const config = testConfig("profiles-parity");
    const handler = createHandler(config);

    const created = await call(handler, config, "/api/profiles", {
      method: "POST",
      body: JSON.stringify({ name: "research", toolsets: ["file", "web", "session_search"], memoryScopes: ["user", "project"] })
    });
    const active = await call(handler, config, `/api/profiles/${created.id}/use`, { method: "POST" });
    const profiles = await call(handler, config, "/api/profiles");
    const parity = await call(handler, config, "/api/parity/hermes");

    expect(active.status).toBe("active");
    expect(profiles.activeProfileId).toBe(created.id);
    expect(parity.ok).toBe(true);
    expect(parity.checks.some((item: { id: string; status: string }) => item.id === "profiles" && item.status === "pass")).toBe(true);
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

function testConfig(lane: string): RuntimeConfig {
  const root = `/tmp/gini-http-test-${lane}`;
  rmSync(root, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  return {
    lane,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/${lane}`,
    logRoot: `${root}-logs/${lane}`
  };
}

async function waitForTask(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, taskId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const detail = await call(handler, config, `/api/tasks/${taskId}`);
    if (["completed", "failed", "waiting_approval"].includes(detail.task.status)) return detail;
    await Bun.sleep(10);
  }
  throw new Error(`Task did not settle: ${taskId}`);
}
