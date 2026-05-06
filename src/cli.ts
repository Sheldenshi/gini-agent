#!/usr/bin/env bun
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { configPath, loadConfig, parseLane, pidPath } from "./paths";
import { install, resetLane, status } from "./domain/runtime";
import { normalizeProvider, providerHealth } from "./provider";
import { readState, readTrace } from "./state";
import { createEvidenceBundle, createSnapshot, restoreSnapshot } from "./domain/harness";
import type { RuntimeConfig } from "./types";

const args = Bun.argv.slice(2);
const cliArgs = stripGlobalArgs(args);
const command = cliArgs[0] ?? "help";
const ephemeralSmoke = command === "smoke" && !hasFlag(args, "--lane") && !process.env.GINI_LANE;
applyGlobalEnvOverrides(args, ephemeralSmoke);
const lane = ephemeralSmoke ? `smoke-${process.pid}-${crypto.randomUUID().slice(0, 6)}` : parseLane(args);
const config = loadConfig(lane);

async function main(): Promise<void> {
  switch (command) {
    case "install":
      install(config);
      print({ installed: true, lane: config.lane, stateRoot: config.stateRoot, port: config.port });
      break;
    case "start":
      await start(config);
      break;
    case "stop":
      stop(config);
      break;
    case "status":
      print(await remoteOrLocalStatus(config));
      break;
    case "doctor":
      print(await doctor(config));
      break;
    case "reset":
      resetLane(config);
      print({ reset: true, lane: config.lane, stateRoot: config.stateRoot });
      break;
    case "task":
      await task(config);
      break;
    case "chat":
      await chat(config);
      break;
    case "approval":
    case "approvals":
      await approval(config);
      break;
    case "memory":
      await memory(config);
      break;
    case "skill":
    case "skills":
      await skill(config);
      break;
    case "job":
    case "jobs":
      await job(config);
      break;
    case "connector":
    case "connectors":
      await connector(config);
      break;
    case "improvement":
    case "improvements":
      await improvement(config);
      break;
    case "pairing":
    case "pair":
      await pairing(config);
      break;
    case "device":
    case "devices":
      await device(config);
      break;
    case "mobile":
      await mobile(config);
      break;
    case "search":
      await search(config);
      break;
    case "toolset":
    case "toolsets":
      await toolset(config);
      break;
    case "subagent":
    case "subagents":
      await subagent(config);
      break;
    case "mcp":
      await mcp(config);
      break;
    case "message":
    case "messaging":
      await messaging(config);
      break;
    case "import":
    case "imports":
      await importInspect(config);
      break;
    case "profile":
    case "profiles":
      await profile(config);
      break;
    case "parity":
      await parity(config);
      break;
    case "relay":
    case "relays":
      await relay(config);
      break;
    case "notification":
    case "notifications":
      await notification(config);
      break;
    case "promotion":
    case "promotions":
      await promotion(config);
      break;
    case "snapshot":
    case "snapshots":
      snapshot(config);
      break;
    case "provider":
      await provider(config);
      break;
    case "trace":
      trace(config);
      break;
    case "audit":
      print(readState(config.lane).audit);
      break;
    case "events":
    case "event":
      print(await api(config, "/api/events"));
      break;
    case "evidence":
      evidence(config);
      break;
    case "smoke":
      await smoke(config, ephemeralSmoke);
      break;
    default:
      help();
  }
}

async function start(config: RuntimeConfig): Promise<boolean> {
  if (await isRunning(config)) {
    print({ running: true, url: url(config), lane: config.lane });
    return false;
  }
  install(config);
  config.port = await availablePort(config.port);
  install(config);
  const child = spawn(process.execPath, ["run", "src/runtime.ts", "--lane", config.lane], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, GINI_LANE: config.lane, GINI_PORT: String(config.port) }
  });
  child.unref();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isRunning(config)) {
      print({ started: true, url: url(config), lane: config.lane });
      return true;
    }
    await Bun.sleep(100);
  }
  throw new Error("Runtime did not become healthy within 5 seconds.");
}

async function availablePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No available port found from ${preferred} to ${preferred + 99}.`);
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => server.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

function stop(config: RuntimeConfig): void {
  const result = stopRuntime(config);
  print(result);
}

function stopRuntime(config: RuntimeConfig) {
  const path = pidPath(config.lane);
  if (!existsSync(path)) {
    return { stopped: false, reason: "No pid file", lane: config.lane };
  }
  const pid = Number(readFileSync(path, "utf8"));
  try {
    process.kill(pid, "SIGTERM");
    rmSync(path, { force: true });
    return { stopped: true, pid, lane: config.lane };
  } catch (error) {
    return { stopped: false, pid, error: error instanceof Error ? error.message : String(error) };
  }
}

async function task(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "submit") {
    const input = restAfter(sub).join(" ").trim();
    if (!input) throw new Error("Usage: gini task submit <prompt>");
    print(await api(config, "/api/tasks", { method: "POST", body: JSON.stringify({ input }) }));
    return;
  }
  if (sub === "show") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error("Usage: gini task show <task-id>");
    print(await api(config, `/api/tasks/${id}`));
    return;
  }
  if (sub === "retry" || sub === "cancel") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error(`Usage: gini task ${sub} <task-id>`);
    print(await api(config, `/api/tasks/${id}/${sub}`, { method: "POST" }));
    return;
  }
  print((await api(config, "/api/tasks")).map(compactTask));
}

async function chat(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "new") {
    const title = restAfter(sub).join(" ").trim() || "New chat";
    print(await api(config, "/api/chat", { method: "POST", body: JSON.stringify({ title }) }));
    return;
  }
  if (sub === "send") {
    const [sessionId, ...contentParts] = restAfter(sub);
    if (!sessionId || contentParts.length === 0) throw new Error("Usage: gini chat send <session-id> <message>");
    print(await api(config, `/api/chat/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: contentParts.join(" ") })
    }));
    return;
  }
  if (sub === "sync") {
    const [sessionId, taskId] = restAfter(sub);
    if (!sessionId || !taskId) throw new Error("Usage: gini chat sync <session-id> <task-id>");
    print(await api(config, `/api/chat/${sessionId}/tasks/${taskId}/sync`, { method: "POST" }));
    return;
  }
  if (sub === "show") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error("Usage: gini chat show <session-id>");
    print(await api(config, `/api/chat/${id}`));
    return;
  }
  print(await api(config, "/api/chat"));
}

async function approval(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "approve" || sub === "deny") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error(`Usage: gini approval ${sub} <approval-id>`);
    print(await api(config, `/api/approvals/${id}/${sub === "approve" ? "approve" : "deny"}`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/approvals"));
}

async function memory(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const content = restAfter(sub).join(" ").trim();
    if (!content) throw new Error("Usage: gini memory add <content>");
    print(await api(config, "/api/memory", { method: "POST", body: JSON.stringify({ content, status: "active" }) }));
    return;
  }
  if (sub === "approve" || sub === "reject") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error(`Usage: gini memory ${sub} <memory-id>`);
    print(await api(config, `/api/memory/${id}/${sub}`, { method: "POST" }));
    return;
  }
  if (sub === "edit") {
    const [id, ...contentParts] = restAfter(sub);
    if (!id || contentParts.length === 0) throw new Error("Usage: gini memory edit <memory-id> <content>");
    print(await api(config, `/api/memory/${id}`, { method: "PATCH", body: JSON.stringify({ content: contentParts.join(" ") }) }));
    return;
  }
  if (sub === "archive" || sub === "delete") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error(`Usage: gini memory ${sub} <memory-id>`);
    print(await api(config, `/api/memory/${id}`, { method: "DELETE" }));
    return;
  }
  print(await api(config, "/api/memory"));
}

async function skill(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const name = restAfter(sub)[0];
    const description = restAfter(sub).slice(1).join(" ");
    if (!name) throw new Error("Usage: gini skill add <name> [description]");
    print(await api(config, "/api/skills", {
      method: "POST",
      body: JSON.stringify({ name, description, trigger: name, steps: [description || `Use ${name}`], status: "draft" })
    }));
    return;
  }
  if (sub === "validate") {
    print(await api(config, "/api/skills/validate"));
    return;
  }
  if (sub === "show" || sub === "test" || sub === "trust" || sub === "disable" || sub === "rollback") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error(`Usage: gini skill ${sub} <skill-id-or-name>`);
    print(await api(config, `/api/skills/${encodeURIComponent(id)}${sub === "show" ? "" : `/${sub}`}`, { method: sub === "show" ? "GET" : "POST" }));
    return;
  }
  if (sub === "search") {
    const query = restAfter(sub).join(" ").trim();
    print(await api(config, `/api/skills?q=${encodeURIComponent(query)}`));
    return;
  }
  print(await api(config, "/api/skills"));
}

async function job(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const [name, intervalRaw, ...promptParts] = restAfter(sub);
    if (!name || !intervalRaw || promptParts.length === 0) throw new Error("Usage: gini job add <name> <interval-seconds> <prompt>");
    print(await api(config, "/api/jobs", {
      method: "POST",
      body: JSON.stringify({ name, intervalSeconds: Number(intervalRaw), prompt: promptParts.join(" ") })
    }));
    return;
  }
  if (["run", "pause", "resume"].includes(sub)) {
    const id = restAfter(sub)[0];
    if (!id) throw new Error(`Usage: gini job ${sub} <job-id>`);
    print(await api(config, `/api/jobs/${id}/${sub}`, { method: "POST" }));
    return;
  }
  if (sub === "remove") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error("Usage: gini job remove <job-id>");
    print(await api(config, `/api/jobs/${id}`, { method: "DELETE" }));
    return;
  }
  if (sub === "runs") {
    const id = restAfter(sub)[0];
    print(await api(config, id ? `/api/jobs/${id}/runs` : "/api/job-runs"));
    return;
  }
  if (sub === "replay") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error("Usage: gini job replay <job-run-id>");
    print(await api(config, `/api/job-runs/${id}/replay`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/jobs"));
}

async function connector(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "health") {
    const id = restAfter(sub)[0] ?? "conn_demo";
    print(await api(config, `/api/connectors/${id}/health`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/connectors"));
}

async function improvement(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "propose") {
    const [kind, title, sourceTaskId, ...contentParts] = restAfter(sub);
    if (!kind || !title) throw new Error("Usage: gini improvement propose memory|skill|job <title> [source-task-id] [content]");
    const content = contentParts.join(" ").trim() || title;
    print(await api(config, "/api/improvements", {
      method: "POST",
      body: JSON.stringify({
        kind,
        title,
        sourceTaskId,
        rationale: sourceTaskId ? `Proposed from trace evidence for ${sourceTaskId}` : "Proposed by user",
        payload: improvementPayload(kind, title, content)
      })
    }));
    return;
  }
  if (sub === "approve" || sub === "reject") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error(`Usage: gini improvement ${sub} <proposal-id>`);
    print(await api(config, `/api/improvements/${id}/${sub}`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/improvements"));
}

async function pairing(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "create";
  if (sub === "claim") {
    const [code, ...nameParts] = restAfter(sub);
    if (!code) throw new Error("Usage: gini pairing claim <code> [device-name]");
    print(await publicApi(config, "/api/pairing/claim", {
      method: "POST",
      body: JSON.stringify({ code, deviceName: nameParts.join(" ") || "CLI device" })
    }));
    return;
  }
  print(await api(config, "/api/pairing", { method: "POST", body: JSON.stringify({ ttlSeconds: 600 }) }));
}

async function device(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "revoke") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error("Usage: gini device revoke <device-id>");
    print(await api(config, `/api/devices/${id}/revoke`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/devices"));
}

async function mobile(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "bootstrap";
  if (sub !== "bootstrap") throw new Error("Usage: gini mobile bootstrap");
  print(await api(config, "/api/mobile/bootstrap"));
}

async function search(config: RuntimeConfig): Promise<void> {
  const query = restAfter(command).join(" ").trim();
  if (!query) throw new Error("Usage: gini search <query>");
  print(await api(config, `/api/search?q=${encodeURIComponent(query)}`));
}

async function toolset(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "enable" || sub === "disable") {
    const name = restAfter(sub)[0];
    if (!name) throw new Error(`Usage: gini toolset ${sub} <name>`);
    print(await api(config, `/api/toolsets/${encodeURIComponent(name)}/${sub}`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/toolsets"));
}

async function subagent(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "spawn") {
    const [name, ...promptParts] = restAfter(sub);
    if (!name || promptParts.length === 0) throw new Error("Usage: gini subagent spawn <name> <prompt>");
    print(await api(config, "/api/subagents", {
      method: "POST",
      body: JSON.stringify({ name, prompt: promptParts.join(" ") })
    }));
    return;
  }
  print(await api(config, "/api/subagents"));
}

async function mcp(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const [name, commandValue, ...args] = restAfter(sub);
    if (!name || !commandValue) throw new Error("Usage: gini mcp add <name> <command> [args...]");
    print(await api(config, "/api/mcp", {
      method: "POST",
      body: JSON.stringify({ name, command: commandValue, args, exposedTools: [] })
    }));
    return;
  }
  if (sub === "health" || sub === "disable") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error(`Usage: gini mcp ${sub} <server-id-or-name>`);
    print(await api(config, `/api/mcp/${encodeURIComponent(id)}/${sub}`, { method: "POST" }));
    return;
  }
  if (sub === "invoke") {
    const [id, toolName, ...payloadParts] = restAfter(sub);
    if (!id || !toolName) throw new Error("Usage: gini mcp invoke <server-id-or-name> <tool-name> [json-input]");
    const input = payloadParts.length > 0 ? JSON.parse(payloadParts.join(" ")) : {};
    print(await api(config, `/api/mcp/${encodeURIComponent(id)}/invoke`, {
      method: "POST",
      body: JSON.stringify({ toolName, input })
    }));
    return;
  }
  print(await api(config, "/api/mcp"));
}

async function messaging(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const [name, kind = "demo", ...targets] = restAfter(sub);
    if (!name) throw new Error("Usage: gini messaging add <name> [kind] [delivery-targets...]");
    print(await api(config, "/api/messaging", {
      method: "POST",
      body: JSON.stringify({ name, kind, deliveryTargets: targets })
    }));
    return;
  }
  if (sub === "health" || sub === "disable") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error(`Usage: gini messaging ${sub} <bridge-id-or-name>`);
    print(await api(config, `/api/messaging/${encodeURIComponent(id)}/${sub}`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/messaging"));
}

async function importInspect(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "inspect") {
    const [source, path] = restAfter(sub);
    if ((source !== "hermes" && source !== "openclaw") || !path) {
      throw new Error("Usage: gini import inspect hermes|openclaw <path>");
    }
    print(await api(config, "/api/imports/inspect", { method: "POST", body: JSON.stringify({ source, path }) }));
    return;
  }
  print(await api(config, "/api/imports"));
}

async function profile(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "create") {
    const [name, ...toolsets] = restAfter(sub);
    if (!name) throw new Error("Usage: gini profile create <name> [toolsets...]");
    print(await api(config, "/api/profiles", {
      method: "POST",
      body: JSON.stringify({ name, toolsets: toolsets.length > 0 ? toolsets : undefined })
    }));
    return;
  }
  if (sub === "use") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error("Usage: gini profile use <profile-id-or-name>");
    print(await api(config, `/api/profiles/${encodeURIComponent(id)}/use`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/profiles"));
}

async function parity(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "hermes";
  if (sub !== "hermes") throw new Error("Usage: gini parity hermes");
  print(await api(config, "/api/parity/hermes"));
}

async function relay(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "add") {
    const [name = "local", endpoint = "local://localhost", mode = "local-only"] = restAfter(sub);
    print(await api(config, "/api/relays", { method: "POST", body: JSON.stringify({ name, endpoint, mode }) }));
    return;
  }
  if (sub === "health") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error("Usage: gini relay health <relay-id-or-name>");
    print(await api(config, `/api/relays/${encodeURIComponent(id)}/health`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/relays"));
}

async function notification(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "queue") {
    const [kind = "runtime", target = "local", ...bodyParts] = restAfter(sub);
    print(await api(config, "/api/notifications", {
      method: "POST",
      body: JSON.stringify({ kind, target, title: `Gini ${kind}`, body: bodyParts.join(" ") })
    }));
    return;
  }
  if (sub === "send") {
    print(await api(config, "/api/notifications/send", { method: "POST" }));
    return;
  }
  if (sub === "ack") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error("Usage: gini notification ack <notification-id>");
    print(await api(config, `/api/notifications/${id}/ack`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/notifications"));
}

async function promotion(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "list";
  if (sub === "propose") {
    const [candidateRef, evidencePath, ...summaryParts] = restAfter(sub);
    if (!candidateRef) throw new Error("Usage: gini promotion propose <candidate-ref> [evidence-path] [summary]");
    print(await api(config, "/api/promotions", {
      method: "POST",
      body: JSON.stringify({
        candidateRef,
        evidencePath,
        summary: summaryParts.join(" ") || `Promote candidate ${candidateRef}`,
        rollbackPlan: "Create a lane snapshot before promotion and restore it if verification fails."
      })
    }));
    return;
  }
  if (sub === "approve" || sub === "reject") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error(`Usage: gini promotion ${sub} <promotion-id>`);
    print(await api(config, `/api/promotions/${id}/${sub}`, { method: "POST" }));
    return;
  }
  print(await api(config, "/api/promotions"));
}

function snapshot(config: RuntimeConfig): void {
  const sub = cliArgs[1] ?? "list";
  if (sub === "create") {
    const reason = restAfter(sub).join(" ").trim() || "Manual snapshot";
    print(createSnapshot(config, reason));
    return;
  }
  if (sub === "restore") {
    const id = restAfter(sub)[0];
    if (!id) throw new Error("Usage: gini snapshot restore <snapshot-id>");
    print(restoreSnapshot(config, id));
    return;
  }
  print(readState(config.lane).snapshots);
}

async function provider(config: RuntimeConfig): Promise<void> {
  const sub = cliArgs[1] ?? "show";
  if (sub === "set") {
    const name = restAfter(sub)[0];
    const model = restAfter(sub)[1];
    if (name !== "echo" && name !== "openai" && name !== "codex" && name !== "openrouter" && name !== "local") {
      throw new Error("Usage: gini provider set echo|openai|codex|openrouter|local [model]");
    }
    config.provider = normalizeProvider({
      name,
      model: model ?? (name === "echo" ? "gini-echo-v0" : name === "codex" ? "gpt-5.4" : name === "openrouter" ? "openrouter/auto" : name === "local" ? "local/default" : "gpt-5.4-mini")
    });
    writeFileSync(configPath(config.lane), `${JSON.stringify(config, null, 2)}\n`);
    print({ updated: true, provider: providerHealth(config), configPath: configPath(config.lane) });
    return;
  }
  if (sub === "catalog") {
    print(await api(config, "/api/providers/catalog"));
    return;
  }
  print(providerHealth(config));
}

function trace(config: RuntimeConfig): void {
  const id = restAfter(command)[0];
  if (!id) throw new Error("Usage: gini trace <task-id>");
  print(readTrace(config.lane, id));
}

function evidence(config: RuntimeConfig): void {
  print(createEvidenceBundle(config));
}

async function smoke(config: RuntimeConfig, ephemeral: boolean): Promise<void> {
  const started = await start(config);
  try {
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
    const profileResult = await api(config, "/api/profiles", {
      method: "POST",
      body: JSON.stringify({ name: "smoke-profile", toolsets: ["file", "memory", "session_search"] })
    });
    await api(config, `/api/profiles/${profileResult.id}/use`, { method: "POST" });
    const parityResult = await api(config, "/api/parity/hermes");
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
    const snapshotResult = createSnapshot(config, "Smoke rollback baseline");
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
      lane: config.lane,
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
      profileId: profileResult.id,
      parityOk: parityResult.ok,
      relayId: relayResult.id,
      notificationId: notificationResult.id,
      snapshotId: snapshotResult.snapshotId,
      promotionId: promotionResult.id,
      connectorHealth: connectorHealth.health,
      traces: finalState.tasks.length,
      auditEvents: finalState.audit.length,
      evidencePath: bundle.path
    });
  } finally {
    if (ephemeral && started) {
      stopRuntime(config);
    }
  }
}

function improvementPayload(kind: string, title: string, content: string): Record<string, unknown> {
  if (kind === "skill") {
    return { name: title, description: content, trigger: title, steps: [content], status: "draft" };
  }
  if (kind === "job") {
    return { name: title, prompt: content, intervalSeconds: 3600 };
  }
  return { content, scope: "project", confidence: 0.75 };
}

async function waitForTask(config: RuntimeConfig, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const detail = await api(config, `/api/tasks/${taskId}`);
    if (["completed", "failed", "waiting_approval"].includes(detail.task.status)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Task did not settle: ${taskId}`);
}

async function doctor(config: RuntimeConfig) {
  const running = await isRunning(config);
  const state = readState(config.lane);
  return {
    ok: true,
    bun: Bun.version,
    lane: config.lane,
    running,
    stateRoot: config.stateRoot,
    port: config.port,
    tokenConfigured: Boolean(config.token),
    provider: providerHealth(config),
    tasks: state.tasks.length,
    pendingApprovals: state.approvals.filter((item) => item.status === "pending").length,
    recommendations: running ? [] : ["Run `bun run gini start` to launch the local runtime."]
  };
}

async function remoteOrLocalStatus(config: RuntimeConfig) {
  try {
    return await api(config, "/api/status");
  } catch {
    return { ...status(config), ok: false, running: false };
  }
}

async function isRunning(config: RuntimeConfig): Promise<boolean> {
  try {
    const response = await fetch(`${url(config)}/api/status`, { headers: auth(config) });
    return response.ok;
  } catch {
    return false;
  }
}

async function api(config: RuntimeConfig, path: string, options: RequestInit = {}) {
  return apiWithToken(config, config.token, path, options);
}

async function apiWithToken(config: RuntimeConfig, token: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${url(config)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(options.headers ?? {}) }
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function publicApi(config: RuntimeConfig, path: string, options: RequestInit = {}) {
  const response = await fetch(`${url(config)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

function auth(config: RuntimeConfig): Record<string, string> {
  return { authorization: `Bearer ${config.token}` };
}

function url(config: RuntimeConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

function restAfter(marker: string): string[] {
  const index = cliArgs.indexOf(marker);
  return index >= 0 ? cliArgs.slice(index + 1) : [];
}

function stripGlobalArgs(values: string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (["--lane", "--state-root", "--log-root", "--port"].includes(values[index] ?? "")) {
      index += 1;
      continue;
    }
    stripped.push(values[index]);
  }
  return stripped;
}

function applyGlobalEnvOverrides(values: string[], ephemeral: boolean): void {
  const stateRoot = flagValue(values, "--state-root");
  const logRoot = flagValue(values, "--log-root");
  const port = flagValue(values, "--port");
  if (stateRoot) process.env.GINI_STATE_ROOT = stateRoot;
  if (logRoot) process.env.GINI_LOG_ROOT = logRoot;
  if (port) process.env.GINI_PORT = port;
  if (ephemeral) {
    process.env.GINI_STATE_ROOT ??= `/tmp/gini-smoke-${process.pid}`;
    process.env.GINI_LOG_ROOT ??= `/tmp/gini-smoke-${process.pid}-logs`;
    process.env.GINI_PORT ??= String(7400 + Math.floor(Math.random() * 1000));
  }
}

function flagValue(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}

function hasFlag(values: string[], flag: string): boolean {
  return values.includes(flag);
}

function compactTask(task: { id: string; status: string; title: string; updatedAt: string }) {
  return { id: task.id, status: task.status, title: task.title, updatedAt: task.updatedAt };
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function help(): void {
  console.log(`Gini CLI

Usage:
  bun run gini install [--lane dev]
  bun run gini start|stop|status|doctor|reset [--lane dev] [--port 7337]
  bun run gini task submit <prompt>
  bun run gini task list
  bun run gini task show <task-id>
  bun run gini approvals
  bun run gini approval approve|deny <approval-id>
  bun run gini memory list|add|approve|reject
  bun run gini skills list|add|show|search|validate|test|trust|disable|rollback
  bun run gini jobs list|add|run|pause|resume|remove|runs|replay
  bun run gini connectors list|health
  bun run gini improvements list|propose|approve|reject
  bun run gini pairing create|claim
  bun run gini devices list|revoke
  bun run gini mobile bootstrap
  bun run gini search <query>
  bun run gini toolsets list|enable|disable
  bun run gini subagents list|spawn
  bun run gini mcp list|add|health|invoke|disable
  bun run gini messaging list|add|health|disable
  bun run gini import inspect hermes|openclaw <path>
  bun run gini profiles list|create|use
  bun run gini parity hermes
  bun run gini relays list|add|health
  bun run gini notifications list|queue|send|ack
  bun run gini promotions list|propose|approve|reject
  bun run gini snapshots list|create|restore
  bun run gini provider show|catalog|set echo|openai|codex|openrouter|local [model]
  bun run gini trace <task-id>
  bun run gini events
  bun run gini audit
  bun run gini evidence
  bun run gini smoke

Global options:
  --lane <name>        Select a persistent lane. Smoke uses an ephemeral lane when omitted.
  --state-root <path>  Override state root for tests or parallel agents.
  --log-root <path>    Override log root for tests or parallel agents.
  --port <number>      Preferred localhost port. Start scans upward if busy.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
