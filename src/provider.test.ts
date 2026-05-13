import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  clearEchoToolCallingResponses,
  clearEchoVisionResponses,
  generateTaskSummary,
  generateToolCallingResponse,
  generateVisionAnalysis,
  normalizeProvider,
  providerHealth,
  setEchoToolCallingResponse,
  setEchoVisionResponse,
  type ToolFunctionSpec
} from "./provider";
import type { RuntimeConfig } from "./types";

describe("provider", () => {
  test("normalizes echo provider for deterministic smoke tests", async () => {
    const provider = normalizeProvider({ name: "echo", model: "" });
    expect(provider).toEqual({ name: "echo", model: "gini-echo-v0" });

    const result = await generateTaskSummary(config(provider), "summarize task", []);
    expect(result.text).toContain("summarize task");
  });

  test("reports missing OpenAI key without exposing secrets", () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const health = providerHealth(config({ name: "openai", model: "gpt-5.4-mini" }));
    expect(health.ok).toBe(false);
    expect(health.message).toContain("OPENAI_API_KEY");
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });

  test("echo tool-calling returns canned text when no stub registered", async () => {
    const provider = normalizeProvider({ name: "echo", model: "" });
    const result = await generateToolCallingResponse(
      config(provider),
      [{ role: "user", content: "hello" }],
      []
    );
    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.text).toContain("hello");
  });

  test("echo tool-calling returns the next stubbed response", async () => {
    const provider = normalizeProvider({ name: "echo", model: "" });
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_1", type: "function", function: { name: "file_read", arguments: '{"path":"a.txt"}' } }
      ],
      finishReason: "tool_calls"
    });
    const result = await generateToolCallingResponse(
      config(provider),
      [{ role: "user", content: "read a.txt" }],
      []
    );
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function.name).toBe("file_read");
    expect(result.toolCalls[0]?.function.arguments).toBe('{"path":"a.txt"}');
    clearEchoToolCallingResponses();
  });

  test("openai tool-calling parses non-streaming responses with tool_calls", async () => {
    const original = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-key";

    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      captured = { url: String(input), init };
      const body = {
        id: "resp_1",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_abc",
              type: "function",
              function: { name: "file_read", arguments: '{"path":"hello.md"}' }
            }]
          }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
      };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    }) as typeof fetch;

    try {
      const provider = normalizeProvider({ name: "openai", model: "gpt-test" });
      const tools: ToolFunctionSpec[] = [{
        type: "function",
        function: {
          name: "file_read",
          description: "read",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
        }
      }];
      const result = await generateToolCallingResponse(
        config(provider),
        [
          { role: "system", content: "sys" },
          { role: "user", content: "please read hello.md" }
        ],
        tools
      );
      expect(result.finishReason).toBe("tool_calls");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.id).toBe("call_abc");
      expect(result.toolCalls[0]?.function.name).toBe("file_read");
      expect(JSON.parse(result.toolCalls[0]?.function.arguments ?? "{}")).toEqual({ path: "hello.md" });
      expect(result.responseId).toBe("resp_1");
      expect(captured?.url).toContain("/chat/completions");
      const sent = JSON.parse(String(captured!.init!.body));
      expect(sent.tools).toHaveLength(1);
      expect(sent.tool_choice).toBe("auto");
      expect(sent.stream).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  test("openai tool-calling streaming buffers tool-call argument deltas", async () => {
    const original = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-key";

    const events = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_zzz", type: "function", function: { name: "file_read", arguments: "" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x.md"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
    ];

    globalThis.fetch = ((() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const e of events) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          }
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }));
    }) as unknown) as typeof fetch;

    try {
      const provider = normalizeProvider({ name: "openai", model: "gpt-test" });
      let streamed = "";
      const result = await generateToolCallingResponse(
        config(provider),
        [{ role: "user", content: "stream me" }],
        [],
        (delta) => { streamed += delta; }
      );
      expect(result.finishReason).toBe("tool_calls");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.function.name).toBe("file_read");
      expect(JSON.parse(result.toolCalls[0]?.function.arguments ?? "{}")).toEqual({ path: "x.md" });
      // No content text was emitted in this stream — streamed buffer empty.
      expect(streamed).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  test("detects Codex auth.json without exposing token values", () => {
    const root = "/tmp/gini-provider-codex-test";
    const authPath = `${root}/auth.json`;
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "secret-access-token",
        refresh_token: "secret-refresh-token"
      }
    }));

    const original = process.env.CODEX_AUTH_JSON;
    process.env.CODEX_AUTH_JSON = authPath;
    const health = providerHealth(config({ name: "codex", model: "gpt-5.4-mini" }));
    expect(health.ok).toBe(true);
    expect(JSON.stringify(health)).not.toContain("secret-access-token");
    expect(JSON.stringify(health)).not.toContain("secret-refresh-token");
    if (original === undefined) delete process.env.CODEX_AUTH_JSON;
    else process.env.CODEX_AUTH_JSON = original;
  });

  test("codex tool-calling parses function_call SSE events from /responses", async () => {
    const { authPath, restore } = installCodexAuth("codex-tool-call-test");
    const originalFetch = globalThis.fetch;
    const events = [
      // Some text first to exercise the delta path.
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Reading " } },
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "now..." } },
      // Function-call lifecycle: announce the item, stream args, finish.
      { event: "response.output_item.added", data: {
        type: "response.output_item.added",
        item: { id: "item_1", type: "function_call", call_id: "call_abc", name: "file_list", arguments: "" }
      } },
      { event: "response.function_call_arguments.delta", data: {
        type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"path":"' } },
      { event: "response.function_call_arguments.delta", data: {
        type: "response.function_call_arguments.delta", item_id: "item_1", delta: '/tmp"}' } },
      { event: "response.function_call_arguments.done", data: {
        type: "response.function_call_arguments.done", item_id: "item_1", arguments: '{"path":"/tmp"}' } },
      { event: "response.output_item.done", data: {
        type: "response.output_item.done",
        item: { id: "item_1", type: "function_call", call_id: "call_abc", name: "file_list", arguments: '{"path":"/tmp"}' }
      } },
      { event: "response.completed", data: {
        type: "response.completed",
        response: {
          id: "resp_codex_1",
          usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
          output: [
            { id: "item_1", type: "function_call", call_id: "call_abc", name: "file_list", arguments: '{"path":"/tmp"}' }
          ]
        }
      } }
    ];

    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      captured = { url: String(input), init };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const ev of events) {
            controller.enqueue(enc.encode(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`));
          }
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }));
    }) as typeof fetch;

    try {
      const provider = normalizeProvider({ name: "codex", model: "gpt-test" });
      const tools: ToolFunctionSpec[] = [{
        type: "function",
        function: {
          name: "file_list",
          description: "list files",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
        }
      }];
      let streamed = "";
      const result = await generateToolCallingResponse(
        config(provider),
        [
          { role: "system", content: "you are gini" },
          { role: "user", content: "list /tmp" }
        ],
        tools,
        (delta) => { streamed += delta; }
      );

      expect(result.finishReason).toBe("tool_calls");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.id).toBe("call_abc");
      expect(result.toolCalls[0]?.function.name).toBe("file_list");
      expect(JSON.parse(result.toolCalls[0]?.function.arguments ?? "{}")).toEqual({ path: "/tmp" });
      expect(result.responseId).toBe("resp_codex_1");
      expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 5, total_tokens: 17 });
      expect(streamed).toBe("Reading now...");
      expect(result.text).toBe("Reading now...");

      // Verify the request body shape: instructions stitched, input items
      // translated, tools flattened.
      expect(captured?.url).toContain("/responses");
      const sent = JSON.parse(String(captured!.init!.body));
      expect(sent.model).toBe("gpt-test");
      expect(sent.store).toBe(false);
      expect(sent.stream).toBe(true);
      expect(sent.instructions).toBe("you are gini");
      expect(sent.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "list /tmp" }] }
      ]);
      expect(sent.tools).toHaveLength(1);
      expect(sent.tools[0]).toEqual({
        type: "function",
        name: "file_list",
        description: "list files",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        strict: false
      });
    } finally {
      globalThis.fetch = originalFetch;
      restore();
      void authPath;
    }
  });

  test("codex tool-calling returns text-only result when no function_call items appear", async () => {
    const { restore } = installCodexAuth("codex-text-only-test");
    const originalFetch = globalThis.fetch;
    const events = [
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Hello, " } },
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "world." } },
      { event: "response.completed", data: {
        type: "response.completed",
        response: {
          id: "resp_codex_text",
          usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
          output: [
            { id: "msg_1", type: "message", content: [{ type: "output_text", text: "Hello, world." }] }
          ]
        }
      } }
    ];

    globalThis.fetch = ((() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const ev of events) {
            controller.enqueue(enc.encode(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`));
          }
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }));
    }) as unknown) as typeof fetch;

    try {
      const provider = normalizeProvider({ name: "codex", model: "gpt-test" });
      const tools: ToolFunctionSpec[] = [{
        type: "function",
        function: { name: "file_list", description: "list", parameters: { type: "object" } }
      }];
      let streamed = "";
      const result = await generateToolCallingResponse(
        config(provider),
        [{ role: "user", content: "say hi" }],
        tools,
        (delta) => { streamed += delta; }
      );
      expect(result.finishReason).toBe("stop");
      expect(result.toolCalls).toEqual([]);
      expect(result.text).toBe("Hello, world.");
      expect(streamed).toBe("Hello, world.");
      expect(result.responseId).toBe("resp_codex_text");
    } finally {
      globalThis.fetch = originalFetch;
      restore();
    }
  });

  test("codex tool-calling round-trips assistant tool_calls and tool results in request body", async () => {
    const { restore } = installCodexAuth("codex-round-trip-test");
    const originalFetch = globalThis.fetch;

    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      captured = { url: String(input), init };
      // Minimal stream — just a final completed event with no items.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          const ev = { type: "response.completed", response: { id: "resp_done", output: [] } };
          controller.enqueue(enc.encode(`event: response.completed\ndata: ${JSON.stringify(ev)}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }));
    }) as typeof fetch;

    try {
      const provider = normalizeProvider({ name: "codex", model: "gpt-test" });
      const tools: ToolFunctionSpec[] = [{
        type: "function",
        function: { name: "file_list", description: "list", parameters: { type: "object" } }
      }];
      const result = await generateToolCallingResponse(
        config(provider),
        [
          { role: "system", content: "you are gini" },
          { role: "user", content: "list /tmp" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_xyz",
              type: "function",
              function: { name: "file_list", arguments: '{"path":"/tmp"}' }
            }]
          },
          {
            role: "tool",
            tool_call_id: "call_xyz",
            content: '{"files":["a.txt","b.txt"]}'
          },
          { role: "user", content: "thanks" }
        ],
        tools
      );

      expect(result.finishReason).toBe("stop");
      const sent = JSON.parse(String(captured!.init!.body));
      expect(sent.instructions).toBe("you are gini");
      expect(sent.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "list /tmp" }] },
        { type: "function_call", call_id: "call_xyz", name: "file_list", arguments: '{"path":"/tmp"}' },
        { type: "function_call_output", call_id: "call_xyz", output: '{"files":["a.txt","b.txt"]}' },
        { role: "user", content: [{ type: "input_text", text: "thanks" }] }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      restore();
    }
  });

  // Fix 1 (graceful exhaustion): when the chat-task loop hits the iteration
  // cap it asks for a final summary with `tools: []` but the message array
  // still carries the prior tool transcript. The codex routing must keep
  // that transcript intact (i.e. take the Responses-API tool-calling path
  // and translate function_call / function_call_output items) instead of
  // collapsing to the text-only legacy path which would strip everything
  // but the system + user messages.
  test("codex with empty tools but tool transcript preserves the full Responses-API input", async () => {
    const { restore } = installCodexAuth("codex-empty-tools-transcript");
    const originalFetch = globalThis.fetch;

    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      captured = { url: String(input), init };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          const ev = { type: "response.completed", response: { id: "resp_summary", output: [
            { id: "msg_1", type: "message", content: [{ type: "output_text", text: "Cap hit. I read /tmp." }] }
          ] } };
          controller.enqueue(enc.encode(`event: response.completed\ndata: ${JSON.stringify(ev)}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }));
    }) as typeof fetch;

    try {
      const provider = normalizeProvider({ name: "codex", model: "gpt-test" });
      const result = await generateToolCallingResponse(
        config(provider),
        [
          { role: "system", content: "you are gini" },
          { role: "user", content: "list /tmp" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_xyz",
              type: "function",
              function: { name: "file_list", arguments: '{"path":"/tmp"}' }
            }]
          },
          {
            role: "tool",
            tool_call_id: "call_xyz",
            content: '{"files":["a.txt","b.txt"]}'
          },
          { role: "user", content: "summarize what you learned" }
        ],
        // Empty tools — the cap-hit summary call passes []. The codex
        // routing must still take the Responses-API path because the
        // history contains tool traffic.
        []
      );

      expect(result.text).toBe("Cap hit. I read /tmp.");
      // Hit the /responses path, not the legacy text-only routing.
      expect(captured?.url).toContain("/responses");
      const sent = JSON.parse(String(captured!.init!.body));
      // No `tools` field when caller passed an empty array — the request
      // body must omit it so providers that reject empty `tools` are happy.
      expect("tools" in sent).toBe(false);
      // Full transcript translated into Responses-API input items.
      expect(sent.instructions).toBe("you are gini");
      expect(sent.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "list /tmp" }] },
        { type: "function_call", call_id: "call_xyz", name: "file_list", arguments: '{"path":"/tmp"}' },
        { type: "function_call_output", call_id: "call_xyz", output: '{"files":["a.txt","b.txt"]}' },
        { role: "user", content: [{ type: "input_text", text: "summarize what you learned" }] }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      restore();
    }
  });

  // ---------------- generateVisionAnalysis ----------------

  test("echo vision returns the next stubbed result", async () => {
    const provider = normalizeProvider({ name: "echo", model: "" });
    setEchoVisionResponse({ text: "echo-vision" });
    const result = await generateVisionAnalysis(config(provider), {
      prompt: "what is on screen?",
      imageBase64: "AAAA",
      mimeType: "image/png"
    });
    expect(result.text).toBe("echo-vision");
    expect(result.provider.name).toBe("echo");
    clearEchoVisionResponses();
  });

  test("echo vision falls back to a deterministic stub when no response is registered", async () => {
    const provider = normalizeProvider({ name: "echo", model: "" });
    clearEchoVisionResponses();
    const result = await generateVisionAnalysis(config(provider), {
      prompt: "describe the image",
      imageBase64: "AAAA",
      mimeType: "image/png"
    });
    expect(result.text).toContain("describe the image");
  });

  test("codex vision posts an input_image to /responses with the data URL", async () => {
    const { restore } = installCodexAuth("codex-vision-test");
    const originalFetch = globalThis.fetch;

    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      captured = { url: String(input), init };
      const body = {
        id: "resp_vision_1",
        output: [
          {
            id: "msg_1",
            type: "message",
            content: [{ type: "output_text", text: "The page shows a login form." }]
          }
        ],
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
      };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    }) as typeof fetch;

    try {
      const provider = normalizeProvider({ name: "codex", model: "gpt-test" });
      const result = await generateVisionAnalysis(config(provider), {
        prompt: "what is on this page?",
        imageBase64: "AAAA",
        mimeType: "image/png",
        maxTokens: 64
      });
      expect(result.text).toBe("The page shows a login form.");
      expect(captured?.url.endsWith("/responses")).toBe(true);
      const sent = JSON.parse(String(captured!.init!.body));
      expect(sent.model).toBe("gpt-test");
      expect(sent.stream).toBe(false);
      expect(sent.max_output_tokens).toBe(64);
      expect(Array.isArray(sent.input)).toBe(true);
      expect(sent.input[0].role).toBe("user");
      expect(Array.isArray(sent.input[0].content)).toBe(true);
      expect(sent.input[0].content[0].type).toBe("input_text");
      expect(sent.input[0].content[0].text).toBe("what is on this page?");
      expect(sent.input[0].content[1].type).toBe("input_image");
      expect(typeof sent.input[0].content[1].image_url).toBe("string");
      expect(sent.input[0].content[1].image_url.startsWith("data:image/png;base64,")).toBe(true);
      expect(sent.input[0].content[1].detail).toBe("low");
    } finally {
      globalThis.fetch = originalFetch;
      restore();
    }
  });

  test("openai vision posts an image_url content part to /chat/completions", async () => {
    const original = process.env.OPENAI_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-key";

    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      captured = { url: String(input), init };
      const body = {
        id: "resp_chat_1",
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: "Looks like a banner." }
        }],
        usage: { prompt_tokens: 80, completion_tokens: 4, total_tokens: 84 }
      };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    }) as typeof fetch;

    try {
      const provider = normalizeProvider({ name: "openai", model: "gpt-test" });
      const result = await generateVisionAnalysis(config(provider), {
        prompt: "what is shown?",
        imageBase64: "BBBB",
        mimeType: "image/jpeg",
        maxTokens: 32
      });
      expect(result.text).toBe("Looks like a banner.");
      expect(captured?.url).toContain("/chat/completions");
      const sent = JSON.parse(String(captured!.init!.body));
      expect(sent.model).toBe("gpt-test");
      // OpenAI now uses max_completion_tokens (some o-series models reject
      // max_tokens entirely). We send only the newer field for the openai
      // provider; openrouter/local keep the legacy max_tokens.
      expect(sent.max_completion_tokens).toBe(32);
      expect(sent.max_tokens).toBeUndefined();
      expect(Array.isArray(sent.messages)).toBe(true);
      expect(sent.messages[0].role).toBe("user");
      expect(Array.isArray(sent.messages[0].content)).toBe(true);
      expect(sent.messages[0].content[0].type).toBe("text");
      expect(sent.messages[0].content[0].text).toBe("what is shown?");
      expect(sent.messages[0].content[1].type).toBe("image_url");
      expect(typeof sent.messages[0].content[1].image_url).toBe("object");
      expect(sent.messages[0].content[1].image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
      expect(sent.messages[0].content[1].image_url.detail).toBe("low");
    } finally {
      globalThis.fetch = originalFetch;
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  test("openrouter vision keeps legacy max_tokens for compat with older OpenAI-style gateways", async () => {
    const original = process.env.OPENROUTER_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.OPENROUTER_API_KEY = "test-or-key";

    let captured: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
      captured = { url: String(input), init };
      const body = {
        id: "resp_or_1",
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: "OR reply." }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    }) as typeof fetch;

    try {
      const provider = normalizeProvider({ name: "openrouter", model: "or-model" });
      await generateVisionAnalysis(config(provider), {
        prompt: "describe",
        imageBase64: "AAAA",
        mimeType: "image/png",
        maxTokens: 16
      });
      const sent = JSON.parse(String(captured!.init!.body));
      // OpenRouter / local / older OpenAI-compat gateways still expect
      // max_tokens; max_completion_tokens isn't sent.
      expect(sent.max_tokens).toBe(16);
      expect(sent.max_completion_tokens).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });
});

// Install a temporary CODEX_AUTH_JSON pointing at a fake auth.json. Tests
// that exercise the codex /responses path need this so readCodexBearer
// resolves a non-empty access token without real OAuth state on disk.
function installCodexAuth(suffix: string): { authPath: string; restore: () => void } {
  const root = `/tmp/gini-provider-codex-${suffix}`;
  const authPath = `${root}/auth.json`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(authPath, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: "test-codex-access-token",
      refresh_token: "test-codex-refresh-token"
    }
  }));
  const original = process.env.CODEX_AUTH_JSON;
  process.env.CODEX_AUTH_JSON = authPath;
  return {
    authPath,
    restore() {
      if (original === undefined) delete process.env.CODEX_AUTH_JSON;
      else process.env.CODEX_AUTH_JSON = original;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function config(provider: RuntimeConfig["provider"]): RuntimeConfig {
  return {
    instance: "test",
    port: 7337,
    token: "test",
    provider,
    workspaceRoot: "/tmp",
    stateRoot: "/tmp/gini-provider-test",
    logRoot: "/tmp/gini-provider-test-logs"
  };
}
