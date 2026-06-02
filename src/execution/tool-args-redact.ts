// Generic redactor for tool-call arguments that may carry secrets.
//
// Tool args flow into two display surfaces a client can render: the
// chat-block `argsFull` field (every tool call's verbatim parsed args)
// and the self.config approval payload (served on the approvals list).
// Some tools take secret args — set_provider.apiKey, rotate_connector.token,
// add_mcp_server.headers (Authorization bearer) — that must not leak into
// either surface. This is the single choke point that scrubs them.
//
// Layering: this is a leaf with no imports, so both chat-task-emit.ts and
// agent.ts can pull it in without forming a cycle through the registry or
// the dispatcher.

const REDACTED = "[redacted]";

// Key names whose VALUES are credentials regardless of nesting depth.
// Matched case-insensitively against the exact key (not a substring) so a
// benign key like "tokenCount" doesn't get scrubbed.
const SENSITIVE_KEYS = new Set([
  "apikey",
  "api_key",
  "api-key",
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "auth",
  "bearer"
]);

// Header maps commonly carry credentials in their VALUES (Authorization,
// X-Api-Key, …). When a key named "headers" holds an object, every value
// under it is redacted rather than trying to enumerate header names.
function redactHeaders(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return redactValue(value);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = REDACTED;
  }
  return out;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else if (key.toLowerCase() === "headers") {
      out[key] = redactHeaders(value);
    } else {
      out[key] = redactValue(value);
    }
  }
  return out;
}

// Return a DEEP copy of `args` with credential-bearing values replaced by
// "[redacted]". Non-matching values pass through unchanged. Safe for
// display: the copy is decoupled from the live args, so the real values
// still reach the handler for execution.
export function redactSensitiveToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  return redactObject(args);
}
