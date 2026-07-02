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

// Strip authentication-bearing headers from a string snippet (typically a
// captured upstream HTTP response body that an MCP server echoed back to
// us). Servers sometimes mirror the request — including the
// `Authorization` header — into error responses, which we then persist
// into `mcpServers[*].message` and `mcp.health` audits. Redact before
// the value lands in state.json or audit evidence.
//
// The redaction is best-effort, not exhaustive: it targets well-known
// auth header names plus any `*-Token` / `*-Key` variant, in both
// header-style (`Name: value`), URL/form-encoded (`?token=` / `&api_key=`),
// and JSON-quoted (`"x-api-key":"value"`) forms. All name matches are
// case-insensitive.
const AUTH_HEADER_NAMES = [
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token"
];

// Query/form-style secret parameter names. Matched after `?` or `&`, or as
// a `name=value` segment at a delimiter boundary (start-of-string, whitespace,
// `&`, `;`, or `,`). Case-insensitive.
const SECRET_QUERY_PARAMS = [
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "api-key",
  "apikey",
  "client_secret"
];

export function redactSecretsInText(input: string): string {
  if (!input) return input;
  let out = input;

  // 1) JSON-quoted form first: `"name"\s*:\s*"value"`. Cover known
  //    auth-bearing header names plus the *-token/*-key tail. Doing
  //    this before the generic header pass means we redact the *contents*
  //    of the quoted value (not just up to the closing quote via the
  //    `[^"]` exclusion in the generic pass, which would still leave
  //    nothing — but the generic pass treats the surrounding `"` as a
  //    stop char and misses this form entirely).
  //
  //    Two variants per name: plain (`"name":"value"`) and escaped
  //    (`\"name\":\"value\"`). The escaped form shows up when an upstream
  //    error embeds a JSON-encoded body inside another JSON string, e.g.
  //    `{"error":"{\"x-api-key\":\"SECRET\"}"}` — the inner JSON arrives
  //    backslash-quoted and the plain variant misses it.
  for (const name of AUTH_HEADER_NAMES) {
    const plain = new RegExp(`("${name}"\\s*:\\s*)"[^"]*"`, "gi");
    out = out.replace(plain, '$1"[REDACTED]"');
    // Escaped form: `\"name\":\"value\"` embedded inside another JSON
    // string. The value must allow JSON-escaped characters — `\\/`, `\\u00xx`,
    // backslash-escaped quotes — so use `(?:[^"\\]|\\.)*` instead of
    // `[^"\\]*`, otherwise the match bails at the first `\\`.
    //
    // Regex source we want: (\\"NAME\\"\s*:\s*)\\"(?:[^"\\]|\\.)*\\"
    // In a string passed to new RegExp, every `\\` doubles to `\\\\`.
    const escaped = new RegExp(`(\\\\"${name}\\\\"\\s*:\\s*)\\\\"(?:[^"\\\\]|\\\\.)*\\\\"`, "gi");
    out = out.replace(escaped, '$1\\"[REDACTED]\\"');
  }
  out = out.replace(/("[A-Za-z][\w-]*-(?:token|key)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
  out = out.replace(/(\\"[A-Za-z][\w-]*-(?:token|key)\\"\s*:\s*)\\"(?:[^"\\]|\\.)*\\"/gi, '$1\\"[REDACTED]\\"');

  // 2) Cookie header: redact the entire value up to newline / end-of-string,
  //    not just up to the first `;`. A `Cookie:` header is a single
  //    header whose value is a `; `-delimited list of `name=value` pairs,
  //    every one of which can be a session token. Same applies to
  //    `Set-Cookie:`.
  //
  //    Not anchored to line start: upstream error strings often paste a
  //    `Cookie: …` fragment mid-prose (e.g. "upstream echoed Cookie:
  //    theme=light; session=SECRET"). Match anywhere; consume until the
  //    next newline OR end-of-string OR a closing JSON token (`"` followed
  //    by `,` or `}`) so we don't accidentally swallow trailing JSON
  //    structure when the header is embedded in a quoted value.
  // Stop on newline, EOS, a literal `]` (so a Cookie fragment embedded in a
  // JSON array like `{"errors":["Cookie: x=Y"], …}` doesn't swallow the
  // closing bracket and everything after it), or a `"` followed by a JSON
  // structural terminator (`,` / `}` / `]`).
  out = out.replace(/((?:set-)?cookie\s*:\s*)(?:(?!"[,}\]])[^\r\n\]])+/gi, "$1[REDACTED]");

  // 3) Header-style well-known auth headers (after Cookie handling so the
  //    Cookie line is already fully redacted). Stops at line terminators
  //    and structural delimiters typical of header dumps.
  for (const name of AUTH_HEADER_NAMES) {
    if (name === "cookie" || name === "set-cookie") continue; // handled above
    const re = new RegExp(`(${name}\\s*[:=]\\s*)([^\\r\\n,;"']+)`, "gi");
    out = out.replace(re, "$1[REDACTED]");
  }

  // 4) Any header-style line that ends in `-token` or `-key` (e.g.
  //    `X-Service-Token: …`). Conservative: requires the name to be at
  //    the start of a line or after `, ` / `; ` to avoid mangling JSON
  //    values that happen to contain "key".
  out = out.replace(/(^|[\r\n,;])([A-Za-z][\w-]*-(?:token|key))\s*:\s*[^\r\n,;"']+/gi, "$1$2: [REDACTED]");

  // 5) URL / form-encoded secret query params (`?token=…`, `&access_token=…`,
  //    `api_key=…`). Value runs until the next `&`, `;`, whitespace, or
  //    end-of-string. Case-insensitive.
  for (const param of SECRET_QUERY_PARAMS) {
    const re = new RegExp(`(^|[?&;,\\s])(${param})=([^&;\\s"'<>\\r\\n]+)`, "gi");
    out = out.replace(re, "$1$2=[REDACTED]");
  }

  // 6) Bearer tokens that appear without a header name (e.g. echoed in a
  //    JSON `"authorization":"Bearer …"` body or in prose). Fully
  //    case-insensitive so `BEARER`, `bEaReR`, etc. are also caught.
  //    Only the immediately following token is consumed — not arbitrary
  //    trailing prose — so a sentence like "Bearer ABC123 then more text"
  //    leaves "then more text" untouched.
  // RFC 6750 b64token: 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"=".
  // The `~` was previously missing; tokens that include it (e.g. PASETO-ish
  // formats) leaked the tail past the first `~`.
  out = out.replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");

  return out;
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
    // Upstream may echo the request headers (including `Authorization`)
    // back in its error body. The body lands in `mcpServers[*].message`
    // and `mcp.health` audit evidence on disk, so we must scrub before
    // returning. See `redactSecretsInText`.
    const safeBody = redactSecretsInText(body);
    return { ok: false, error: `MCP HTTP ${response.status}${safeBody ? `: ${safeBody}` : ""}` };
  }
  const raw = await response.text();
  const payload = parseRpcPayload(raw, id);
  if (!payload.ok) return payload;
  if (payload.body && typeof payload.body === "object" && "error" in payload.body) {
    const err = (payload.body as { error: { message?: string; code?: number } }).error;
    // JSON-RPC error messages can include echoed request metadata (including
    // Authorization), same hazard as the non-2xx HTTP body above. Scrub
    // before returning so the message never lands in audit evidence raw.
    const safeMessage = err.message ? redactSecretsInText(err.message) : undefined;
    return { ok: false, error: safeMessage ?? `MCP error code ${err.code ?? "?"}` };
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
