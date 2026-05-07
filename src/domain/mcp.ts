import type { RuntimeConfig } from "../types";
import { addAudit, appendEvent, createMcpServerRecord, mutateState, now, readState } from "../state";
import { spawn } from "bun";

export async function addMcpServer(config: RuntimeConfig, input: Record<string, unknown>) {
  const name = String(input.name ?? "");
  const command = String(input.command ?? "");
  if (!name || !command) throw new Error("MCP server name and command are required.");
  return mutateState(config.lane, (state) => createMcpServerRecord(state, {
    name,
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    envKeys: Array.isArray(input.envKeys) ? input.envKeys.map(String) : [],
    exposedTools: Array.isArray(input.exposedTools) ? input.exposedTools.map(String) : []
  }));
}

export async function checkMcpServer(config: RuntimeConfig, idOrName: string) {
  const server = readState(config.lane).mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
  if (!server) throw new Error(`MCP server not found: ${idOrName}`);
  const probe = server.status === "configured" ? await runMcpProbe(config, server.command, server.args) : { ok: false, message: "MCP server is disabled." };
  return mutateState(config.lane, (state) => {
    const server = state.mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
    if (!server) throw new Error(`MCP server not found: ${idOrName}`);
    server.lastHealthAt = now();
    server.status = probe.ok ? "configured" : "error";
    server.message = probe.message;
    server.updatedAt = server.lastHealthAt;
    addAudit(state, {
      actor: "runtime",
      action: "mcp.health",
      target: server.id,
      risk: "low",
      evidence: { status: server.status, exposedTools: server.exposedTools, probe }
    });
    return server;
  });
}

export async function invokeMcpTool(config: RuntimeConfig, idOrName: string, toolName: string, input: Record<string, unknown> = {}) {
  const server = readState(config.lane).mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
  if (!server) throw new Error(`MCP server not found: ${idOrName}`);
  if (server.status !== "configured") throw new Error(`MCP server is not configured: ${idOrName}`);
  if (server.exposedTools.length > 0 && !server.exposedTools.includes(toolName)) throw new Error(`MCP tool is not exposed: ${toolName}`);
  const result = await runMcpProbe(config, server.command, [...server.args, JSON.stringify(input)]);
  await mutateState(config.lane, (state) => {
    addAudit(state, {
      actor: "runtime",
      action: "mcp.tool.invoked",
      target: server.id,
      risk: "medium",
      evidence: { toolName, ok: result.ok, stdout: result.stdout?.slice(0, 1000), stderr: result.stderr?.slice(0, 1000) }
    });
    appendEvent(state, {
      kind: "mcp",
      action: "mcp.tool.invoked",
      target: server.id,
      risk: "medium",
      summary: result.ok ? `MCP tool ${toolName} invoked.` : `MCP tool ${toolName} failed.`,
      data: { toolName, result }
    });
  });
  return { serverId: server.id, toolName, ...result };
}

export async function removeMcpServer(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.lane, (state) => {
    const server = state.mcpServers.find((item) => item.id === idOrName || item.name === idOrName);
    if (!server) throw new Error(`MCP server not found: ${idOrName}`);
    server.status = "disabled";
    server.updatedAt = now();
    addAudit(state, { actor: "user", action: "mcp.disabled", target: server.id, risk: "medium" });
    return server;
  });
}

async function runMcpProbe(config: RuntimeConfig, command: string, args: string[]) {
  try {
    const proc = spawn([command, ...args], { cwd: config.workspaceRoot, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => proc.kill(), 3000);
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timeout);
    return {
      ok: exitCode === 0,
      message: exitCode === 0 ? "MCP server command completed health probe." : `MCP command exited ${exitCode}.`,
      exitCode,
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 4000)
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
