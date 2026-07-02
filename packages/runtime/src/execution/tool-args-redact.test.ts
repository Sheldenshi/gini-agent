// Coverage for redactSensitiveToolArgs — the single scrubber applied to the
// chat-block argsFull and the resolved self.config approval payload so secret
// tool args (apiKey / token / Authorization header) never reach a display
// surface a client renders.

import { describe, expect, test } from "bun:test";
import { redactSensitiveToolArgs } from "./tool-args-redact";

describe("redactSensitiveToolArgs", () => {
  test("redacts credential-bearing keys case-insensitively", () => {
    const out = redactSensitiveToolArgs({
      apiKey: "sk-123",
      api_key: "sk-456",
      "api-key": "sk-789",
      token: "t-abc",
      Secret: "s-1",
      password: "p-1",
      passwd: "p-2",
      Authorization: "Bearer xyz",
      auth: "a-1",
      bearer: "b-1"
    });
    expect(out).toEqual({
      apiKey: "[redacted]",
      api_key: "[redacted]",
      "api-key": "[redacted]",
      token: "[redacted]",
      Secret: "[redacted]",
      password: "[redacted]",
      passwd: "[redacted]",
      Authorization: "[redacted]",
      auth: "[redacted]",
      bearer: "[redacted]"
    });
  });

  test("passes non-sensitive fields through unchanged", () => {
    const out = redactSensitiveToolArgs({
      provider: "openai",
      model: "gpt-5",
      tokenCount: 42,
      apiKey: "sk-secret"
    });
    expect(out).toEqual({
      provider: "openai",
      model: "gpt-5",
      tokenCount: 42,
      apiKey: "[redacted]"
    });
  });

  test("redacts at nesting depth in objects and arrays", () => {
    const out = redactSensitiveToolArgs({
      outer: { inner: { token: "deep", keep: "v" } },
      list: [{ password: "p" }, { ok: "yes" }]
    });
    expect(out).toEqual({
      outer: { inner: { token: "[redacted]", keep: "v" } },
      list: [{ password: "[redacted]" }, { ok: "yes" }]
    });
  });

  test("redacts ALL values under a headers object (header values carry credentials)", () => {
    const out = redactSensitiveToolArgs({
      name: "linear",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer xyz", "X-Custom": "value" }
    });
    expect(out).toEqual({
      name: "linear",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "[redacted]", "X-Custom": "[redacted]" }
    });
  });

  test("returns a deep copy that does not mutate the input", () => {
    const input = { apiKey: "sk-live", nested: { token: "t" } };
    const out = redactSensitiveToolArgs(input);
    expect(input.apiKey).toBe("sk-live");
    expect(input.nested.token).toBe("t");
    expect(out.apiKey).toBe("[redacted]");
  });
});
