// Tiny in-process OpenAI-compatible HTTP server for integration tests.
//
// Implements the slice of the OpenAI API surface that gini speaks: POST
// /v1/chat/completions (sync + streaming) and POST /v1/embeddings. Returns
// deterministic responses derived from the request — no real model, no
// downloads, no native bindings — so `bun test` works on a fresh clone with
// only `bun install` already done.
//
// Two reasons this exists alongside the fetch-mock tests in
// src/provider.test.ts:
//   1. The mocks stub `globalThis.fetch`, so they don't catch URL construction
//      bugs, header-encoding mistakes, or JSON-stringify edge cases. A real
//      socket round-trip does.
//   2. Anyone who clones the repo can flip a local provider to point at this
//      server's URL and exercise the full chat-task agent loop end-to-end
//      without an API key or external service. Useful for reproducing user
//      reports against a known-deterministic backend.
//
// Behavior:
//   - Echoes the last user message back as assistant content. Lets tests
//     assert on round-trip without seeding stub data.
//   - When the request includes a `tools` array AND the last user message
//     starts with "call:<tool>:<json-args>", emits a tool_call response so
//     tests can drive the agent loop without coordinating a smarter mock.
//   - Streaming SSE is supported via `stream: true`. Splits the canned text
//     into ~5-character chunks so the receiver exercises buffer assembly.
//   - Captures every received non-probe request (URL, method, headers, parsed
//     body) in `received[]` for tests to inspect after the call returns.
//     `/v1/models` health probes are intentionally NOT pushed so callers can
//     wait on readiness without skewing per-test request counts.
//   - The `authorization` header is redacted to `[REDACTED]` before being
//     stored in `received[]`. Tests that need to assert auth presence/shape
//     check for that sentinel; the real bearer never lands in test output
//     even if a developer points the mock at a real env-keyed provider.
//   - `/v1/embeddings` returns a deterministic 16-dim hash-bag vector per
//     input string. Same input → same vector across runs.

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockServerHandle {
  url: string;
  port: number;
  received: CapturedRequest[];
  stop(): Promise<void>;
}

interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface ChatRequestBody {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  tools?: unknown[];
  response_format?: { type?: string };
  // chat_template_kwargs and any other extra_body fields land here too —
  // tests should be able to read them off the captured body.
  [key: string]: unknown;
}

const TOOL_CALL_PREFIX = "call:";

export function startOpenAIMockServer(): MockServerHandle {
  const received: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0, // OS-assigned, avoids collisions with parallel test files
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);

      // Health probe — intentionally do NOT capture into `received[]` so
      // callers can poll for readiness without inflating per-test request
      // counts (a primary cause of flakiness in shared-server fixtures).
      if (url.pathname === "/v1/models" && req.method === "GET") {
        return Response.json({ data: [{ id: "mock-model", object: "model" }] });
      }

      let parsed: unknown = null;
      try {
        parsed = req.method === "GET" ? null : await req.json();
      } catch {
        parsed = null;
      }
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        // Redact the bearer before storing. Tests that need to assert auth
        // presence check for the `[REDACTED]` sentinel rather than the raw
        // token, so a real key accidentally pointed at this mock never lands
        // in CI logs.
        headers[key] = key.toLowerCase() === "authorization" ? "[REDACTED]" : value;
      });
      received.push({ url: req.url, method: req.method, headers, body: parsed });

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        return handleChatCompletions(parsed as ChatRequestBody);
      }
      if (url.pathname === "/v1/embeddings" && req.method === "POST") {
        return handleEmbeddings(parsed as { input?: unknown; model?: string });
      }
      return Response.json({ error: { message: `Mock has no handler for ${req.method} ${url.pathname}` } }, { status: 404 });
    }
  });

  // Bun.serve with port: 0 always assigns an OS port — narrow for TS.
  const port = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    received,
    async stop() {
      await server.stop(true);
    }
  };
}

function handleChatCompletions(body: ChatRequestBody): Response {
  const model = typeof body.model === "string" ? body.model : "mock-model";
  const lastUser = lastUserText(body.messages ?? []);
  const wantStream = body.stream === true;
  const wantsJson = body.response_format?.type === "json_object";

  const toolCall = parseToolCallDirective(lastUser, body.tools);
  if (toolCall) {
    return wantStream
      ? streamingToolCallResponse(model, toolCall)
      : Response.json({
        id: "mock_tc_1",
        object: "chat.completion",
        model,
        choices: [{
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: toolCall.id,
              type: "function",
              function: { name: toolCall.name, arguments: toolCall.arguments }
            }]
          }
        }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
      });
  }

  const content = wantsJson
    ? JSON.stringify(mockJsonResponse(lastUser))
    : `mock-echo: ${lastUser}`;

  return wantStream
    ? streamingTextResponse(model, content)
    : Response.json({
      id: "mock_chat_1",
      object: "chat.completion",
      model,
      choices: [{
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content }
      }],
      usage: { prompt_tokens: lastUser.length, completion_tokens: content.length, total_tokens: lastUser.length + content.length }
    });
}

function mockJsonResponse(lastUser: string): Record<string, string> {
  if (lastUser.includes("ChatTitle schema")) {
    return { title: mockChatTitle(lastUser) };
  }
  return { echo: lastUser };
}

function mockChatTitle(prompt: string): string {
  const lower = prompt.toLowerCase();
  if (lower.includes("garden") && lower.includes("maintenance")) {
    return "Garden Maintenance Plan";
  }
  return "Mock Chat Title";
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === "user") {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        // Vision / multi-part — extract first text part.
        for (const part of c) {
          if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
            return (part as { text: string }).text;
          }
        }
      }
    }
  }
  return "";
}

interface ParsedToolCall { id: string; name: string; arguments: string }

function parseToolCallDirective(lastUser: string, tools: unknown): ParsedToolCall | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  if (!lastUser.startsWith(TOOL_CALL_PREFIX)) return null;
  const tail = lastUser.slice(TOOL_CALL_PREFIX.length);
  const colonAt = tail.indexOf(":");
  if (colonAt < 0) return null;
  const name = tail.slice(0, colonAt);
  const args = tail.slice(colonAt + 1);
  if (!name) return null;
  return { id: `mock_call_${name}`, name, arguments: args };
}

function streamingTextResponse(model: string, content: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const chunks = chunk(content, 5);
      for (const piece of chunks) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({
          id: "mock_chat_stream_1",
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: { content: piece } }]
        })}\n\n`));
      }
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        id: "mock_chat_stream_1",
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      })}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function streamingToolCallResponse(model: string, call: ParsedToolCall): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      // First delta: tool_call announcement with id+name, empty arguments.
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        id: "mock_tc_stream_1",
        object: "chat.completion.chunk",
        model,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] }
        }]
      })}\n\n`));
      // Stream the arguments in small slices so receivers exercise their
      // per-index argument-buffer assembly.
      for (const piece of chunk(call.arguments, 5)) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({
          id: "mock_tc_stream_1",
          object: "chat.completion.chunk",
          model,
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }
          }]
        })}\n\n`));
      }
      controller.enqueue(enc.encode(`data: ${JSON.stringify({
        id: "mock_tc_stream_1",
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
      })}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunk(text: string, size: number): string[] {
  if (text.length === 0) return [""];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function handleEmbeddings(body: { input?: unknown; model?: string }): Response {
  const inputs = Array.isArray(body.input)
    ? body.input.map((v) => String(v))
    : [String(body.input ?? "")];
  const data = inputs.map((text, index) => ({
    object: "embedding",
    index,
    embedding: hashBagEmbedding(text)
  }));
  return Response.json({
    object: "list",
    data,
    model: typeof body.model === "string" ? body.model : "mock-embedding",
    usage: { prompt_tokens: inputs.reduce((sum, t) => sum + t.length, 0), total_tokens: inputs.reduce((sum, t) => sum + t.length, 0) }
  });
}

// Deterministic 16-dim hash-bag — identical text → identical vector. Mirrors
// the echo-embedding spirit but lives over the wire so it exercises the JSON
// round-trip in src/embeddings.ts (which strips Float32Array typing on the
// receive side).
function hashBagEmbedding(text: string): number[] {
  const dim = 16;
  const out = new Array<number>(dim).fill(0);
  if (text.length === 0) return out;
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    out[hash % dim] += 1;
  }
  // L2 normalize so cosine across mock vectors lands in [0, 1].
  let sumSq = 0;
  for (const v of out) sumSq += v * v;
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < dim; i += 1) out[i] = out[i]! / norm;
  return out;
}
