import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { generateTaskSummary, normalizeProvider, providerHealth } from "./provider";
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
});

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
