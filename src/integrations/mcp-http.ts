// Minimal MCP streamable-HTTP client.
//
// Hosted MCP servers (Linear, GitHub, Notion, etc.) speak JSON-RPC 2.0
// over a single POST that may return either application/json or an SSE
// stream. Servers like Linear default to SSE even when the request looks
// stateless, so we always parse for `data:` framing first and fall back to
// straight JSON.
//
// The three exported helpers are intentionally stateless — no session id,
// no retry logic. Callers supply the resolved url + header map; this
// module never reads connector secrets directly so secret-handling stays
// in src/integrations/mcp.ts.

import type { McpToolSpec } from "../types";

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 30_000;

let nextId = 0;
function rpcId(): number {
  nextId = (nextId + 1) % 1_000_000;
  return nextId;
}

export interface McpInitializeResult {
  ok: boolean;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  error?: string;
}

export interface McpListToolsResult {
  ok: boolean;
  tools?: McpToolSpec[];
  error?: string;
}

export interface McpCallToolResult {
  ok: boolean;
  content?: string;
  isError?: boolean;
  error?: string;
}

// Resolve `${VAR}` placeholders inside a header value against the supplied
// env map. Returns undefined when any referenced var is missing; callers
// treat that as a missing-credential error rather than sending the literal
// `${VAR}` string upstream.
export function resolveHeaderValue(value: string, env: Record<string, string>): string | undefined {
  let missing = false;
  const replaced = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined || v === "") {
      missing = true;
      return "";
    }
    return v;
  });
  return missing ? undefined : replaced;
}

// Wrap fetch with an AbortController so a hanging server doesn't stall the
// agent loop forever. The model surfaces the timeout as a tool error and
// can recover.
async function postRpc(url: string, headers: Record<string, string>, method: string, params: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const id = rpcId();
  const merged: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    ...headers
  };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: merged,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `MCP request timed out after ${DEFAULT_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  clearTimeout(timer);
  if (!response.ok) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 500);
    } catch {
      body = "";
    }
    return { ok: false, error: `MCP HTTP ${response.status}${body ? `: ${body}` : ""}` };
  }
  const raw = await response.text();
  const payload = parseRpcPayload(raw, id);
  if (!payload.ok) return payload;
  if (payload.body && typeof payload.body === "object" && "error" in payload.body) {
    const err = (payload.body as { error: { message?: string; code?: number } }).error;
    return { ok: false, error: err.message ?? `MCP error code ${err.code ?? "?"}` };
  }
  if (payload.body && typeof payload.body === "object" && "result" in payload.body) {
    return { ok: true, result: (payload.body as { result: unknown }).result };
  }
  return { ok: false, error: "MCP response had no result or error field" };
}

// Pull the first JSON-RPC envelope out of the response. Servers that
// advertise SSE wrap the body in `event:`/`data:` frames; servers that
// answer plain JSON give us the envelope directly.
function parseRpcPayload(raw: string, expectedId: number): { ok: true; body: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "MCP response body was empty" };
  // SSE framing: split on blank-line boundaries, find the first data: line
  // with a JSON object that has either result or error.
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const frames = trimmed.split(/\n\n+/);
    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as { id?: number };
          if (parsed.id !== expectedId && parsed.id !== undefined) continue;
          return { ok: true, body: parsed };
        } catch {
          // Skip non-JSON keepalive frames.
          continue;
        }
      }
    }
    return { ok: false, error: "MCP SSE stream had no parseable data frame" };
  }
  try {
    return { ok: true, body: JSON.parse(trimmed) };
  } catch (error) {
    return { ok: false, error: `MCP response was not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function httpMcpInitialize(url: string, headers: Record<string, string>): Promise<McpInitializeResult> {
  const rpc = await postRpc(url, headers, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "gini", version: "0.1.0" }
  });
  if (!rpc.ok) return { ok: false, error: rpc.error };
  const result = rpc.result as { serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> } | undefined;
  return {
    ok: true,
    serverInfo: result?.serverInfo,
    capabilities: result?.capabilities
  };
}

export async function httpMcpListTools(url: string, headers: Record<string, string>): Promise<McpListToolsResult> {
  const rpc = await postRpc(url, headers, "tools/list", {});
  if (!rpc.ok) return { ok: false, error: rpc.error };
  const result = rpc.result as { tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }> } | undefined;
  if (!result?.tools || !Array.isArray(result.tools)) {
    return { ok: false, error: "MCP tools/list returned no tools array" };
  }
  const tools: McpToolSpec[] = [];
  for (const entry of result.tools) {
    if (!entry || typeof entry.name !== "string" || entry.name.length === 0) continue;
    tools.push({
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : undefined,
      inputSchema: entry.inputSchema && typeof entry.inputSchema === "object" ? entry.inputSchema : undefined
    });
  }
  return { ok: true, tools };
}

export async function httpMcpCallTool(
  url: string,
  headers: Record<string, string>,
  name: string,
  args: Record<string, unknown>
): Promise<McpCallToolResult> {
  const rpc = await postRpc(url, headers, "tools/call", { name, arguments: args });
  if (!rpc.ok) return { ok: false, error: rpc.error };
  const result = rpc.result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
  if (!result?.content || !Array.isArray(result.content)) {
    return { ok: false, error: "MCP tools/call returned no content array" };
  }
  // Flatten text parts. Non-text parts are surfaced as their JSON shape so
  // the model at least sees structure, even though it loses the visual
  // payload.
  const pieces: string[] = [];
  for (const part of result.content) {
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      pieces.push(part.text);
    } else {
      pieces.push(JSON.stringify(part));
    }
  }
  return {
    ok: !result.isError,
    content: pieces.join("\n"),
    isError: result.isError === true
  };
}
