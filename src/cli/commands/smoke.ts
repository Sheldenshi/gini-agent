// End-to-end smoke that exercises every governed surface against a fresh
// runtime. Intentionally long: every step here corresponds to a contract the
// runtime promises to keep, so removing one drops smoke coverage of that
// contract. Output keys feed parity/readiness reports.
import type { CliContext } from "../context";
import type { RuntimeConfig } from "../../types";
import { createEvidenceBundle, createSnapshot } from "../../runtime/harness";
import { api, apiWithToken, publicApi } from "../api";
import { start as startLifecycle, stopRuntime, waitForTask } from "../process";
import { print } from "../output";

export async function smoke(ctx: CliContext): Promise<void> {
  const { config, ephemeralSmoke, web } = ctx;
  const { runtimeStarted, banner } = await startLifecycle(config, web);
  // Reproduce the original behavior: print the start banner before the smoke
  // body runs, so users see the URL even if smoke fails halfway through.
  print(banner);
  try {
    await runSmokeFlow(config, ephemeralSmoke);
  } finally {
    if (ephemeralSmoke && runtimeStarted) {
      stopRuntime(config);
    }
  }
}

async function runSmokeFlow(config: RuntimeConfig, ephemeral: boolean): Promise<void> {
  const task = await api(config, "/api/tasks", { method: "POST", body: JSON.stringify({ input: "remember Gini v0 prefers seamless Hermes-style continuity" }) });
  await waitForTask(config, task.id);
  const state = await api(config, "/api/state");
  const memory = state.memories.find((item: { status: string }) => item.status === "proposed");
  if (!memory) throw new Error("Smoke failed: no memory proposal created.");
  await api(config, `/api/memory/${memory.id}/approve`, { method: "POST" });
  const job = await api(config, "/api/jobs", { method: "POST", body: JSON.stringify({ name: "smoke", intervalSeconds: 60, prompt: "smoke job task" }) });
  await api(config, `/api/jobs/${job.id}/run`, { method: "POST" });
  const readTask = await api(config, "/api/tasks", { method: "POST", body: JSON.stringify({ input: "read README.md" }) });
  await waitForTask(config, readTask.id);
  const listTask = await api(config, "/api/tasks", { method: "POST", body: JSON.stringify({ input: "list src" }) });
  await waitForTask(config, listTask.id);
  const findTask = await api(config, "/api/tasks", { method: "POST", body: JSON.stringify({ input: "find Gini in README.md" }) });
  await waitForTask(config, findTask.id);
  const proposal = await api(config, "/api/improvements", {
    method: "POST",
    body: JSON.stringify({
      kind: "skill",
      title: "smoke-review",
      sourceTaskId: task.id,
      rationale: "Smoke validates trace-backed governed improvement proposals.",
      payload: { name: "smoke-review", description: "Review smoke traces", trigger: "smoke", steps: ["Inspect task trace", "Summarize evidence"] }
    })
  });
  await api(config, `/api/improvements/${proposal.id}/approve`, { method: "POST" });
  const connectorHealth = await api(config, "/api/connectors/conn_demo/health", { method: "POST" });
  const pairingResult = await api(config, "/api/pairing", { method: "POST", body: JSON.stringify({ ttlSeconds: 300 }) });
  const claimedDevice = await publicApi(config, "/api/pairing/claim", {
    method: "POST",
    body: JSON.stringify({ code: pairingResult.code, deviceName: "Smoke device" })
  });
  const mobileState = await apiWithToken(config, claimedDevice.token, "/api/mobile/bootstrap");
  const searchResults = await api(config, "/api/search?q=Hermes");
  await api(config, "/api/toolsets/mcp/enable", { method: "POST" });
  const subagentResult = await api(config, "/api/subagents", {
    method: "POST",
    body: JSON.stringify({ name: "smoke-subagent", prompt: "summarize smoke subagent capability", toolsets: ["memory", "session_search"] })
  });
  const mcpResult = await api(config, "/api/mcp", {
    method: "POST",
    body: JSON.stringify({ name: "smoke-mcp", command: "echo", args: ["ok"], exposedTools: ["smoke.echo"] })
  });
  await api(config, `/api/mcp/${mcpResult.id}/health`, { method: "POST" });
  const messagingResult = await api(config, "/api/messaging", {
    method: "POST",
    body: JSON.stringify({ name: "smoke-messaging", kind: "demo", deliveryTargets: ["local"] })
  });
  await api(config, `/api/messaging/${messagingResult.id}/health`, { method: "POST" });
  const importResult = await api(config, "/api/imports/inspect", {
    method: "POST",
    body: JSON.stringify({ source: "hermes", path: process.cwd() })
  });
  const agentResult = await api(config, "/api/agents", {
    method: "POST",
    body: JSON.stringify({ name: "smoke-agent", toolsets: ["file", "memory", "session_search"] })
  });
  await api(config, `/api/agents/${agentResult.id}/use`, { method: "POST" });
  const parityResult = await api(config, "/api/parity/hermes");
  const readinessResult = await api(config, "/api/readiness/v1");
  const relayResult = await api(config, "/api/relays", {
    method: "POST",
    body: JSON.stringify({ name: "smoke-relay", endpoint: "local://smoke", mode: "local-only" })
  });
  await api(config, `/api/relays/${relayResult.id}/health`, { method: "POST" });
  const notificationResult = await api(config, "/api/notifications", {
    method: "POST",
    body: JSON.stringify({ kind: "runtime", target: "local", title: "Smoke notification", body: "Smoke notification delivery" })
  });
  await api(config, "/api/notifications/send", { method: "POST" });
  const snapshotResult = await createSnapshot(config, "Smoke rollback baseline");
  const promotionResult = await api(config, "/api/promotions", {
    method: "POST",
    body: JSON.stringify({
      candidateRef: "smoke-candidate",
      evidencePath: snapshotResult.path,
      summary: "Smoke validates promotion proposal records.",
      rollbackPlan: `Restore snapshot ${snapshotResult.snapshotId}`
    })
  });
  const finalState = await api(config, "/api/state");
  const bundle = createEvidenceBundle(config);
  print({
    ok: true,
    instance: config.instance,
    ephemeral,
    stateRoot: config.stateRoot,
    logRoot: config.logRoot,
    port: config.port,
    taskId: task.id,
    approvedMemoryId: memory.id,
    jobId: job.id,
    readTaskId: readTask.id,
    listTaskId: listTask.id,
    findTaskId: findTask.id,
    improvementId: proposal.id,
    pairedDeviceId: claimedDevice.device.id,
    mobileTaskCount: mobileState.tasks.length,
    searchResults: searchResults.length,
    subagentId: subagentResult.id,
    mcpId: mcpResult.id,
    messagingId: messagingResult.id,
    importReportId: importResult.id,
    agentId: agentResult.id,
    parityOk: parityResult.ok,
    readinessOk: readinessResult.ok,
    relayId: relayResult.id,
    notificationId: notificationResult.id,
    snapshotId: snapshotResult.snapshotId,
    promotionId: promotionResult.id,
    connectorHealth: connectorHealth.health,
    traces: finalState.tasks.length,
    auditEvents: finalState.audit.length,
    evidencePath: bundle.path
  });
}
