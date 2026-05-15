// Unit tests for the `gini provider set` command — focused on argument
// parsing, especially the new --base-url / --api-key-env / --extra-body
// flags introduced for OpenAI-compatible local servers like oMLX.
//
// We isolate state per test by pointing HOME and GINI_STATE_ROOT at a fresh
// tmp dir so the real-on-disk config.json never gets touched. The command's
// print() output goes to stdout — we don't assert on it; the source of
// truth for these tests is the persisted config.json contents.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CliContext } from "../context";
import type { RuntimeConfig } from "../../types";
import { provider } from "./provider";

describe("provider CLI", () => {
  let scratchHome: string;
  let originalHome: string | undefined;
  let originalState: string | undefined;

  beforeEach(() => {
    scratchHome = `/tmp/gini-provider-cli-tests/${process.pid}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(scratchHome, { recursive: true });
    originalHome = process.env.HOME;
    originalState = process.env.GINI_STATE_ROOT;
    process.env.HOME = scratchHome;
    process.env.GINI_STATE_ROOT = join(scratchHome, ".gini");
    // Pre-create the instance dir so writeFileSync(configPath(...)) succeeds.
    mkdirSync(join(process.env.GINI_STATE_ROOT, "instances", "test-instance"), { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = originalState;
    rmSync(scratchHome, { recursive: true, force: true });
  });

  test("set local accepts --base-url, --api-key-env, --extra-body and persists them", async () => {
    const ctx = makeCtx([
      "provider", "set", "local", "gemma-4-26b-a4b-it-uncensored-8bit",
      "--base-url", "http://127.0.0.1:8000/v1",
      "--api-key-env", "GINI_LOCAL_API_KEY",
      "--extra-body", JSON.stringify({ chat_template_kwargs: { preserve_thinking: false, enable_thinking: true } })
    ]);
    await provider(ctx);
    const cfgPath = join(process.env.GINI_STATE_ROOT!, "instances", "test-instance", "config.json");
    const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(persisted.provider.name).toBe("local");
    expect(persisted.provider.model).toBe("gemma-4-26b-a4b-it-uncensored-8bit");
    expect(persisted.provider.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(persisted.provider.apiKeyEnv).toBe("GINI_LOCAL_API_KEY");
    expect(persisted.provider.extraBody).toEqual({
      chat_template_kwargs: { preserve_thinking: false, enable_thinking: true }
    });
  });

  test("set local with no flags falls back to normalizeProvider defaults", async () => {
    const ctx = makeCtx(["provider", "set", "local"]);
    await provider(ctx);
    const cfgPath = join(process.env.GINI_STATE_ROOT!, "instances", "test-instance", "config.json");
    const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(persisted.provider.name).toBe("local");
    expect(persisted.provider.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(persisted.provider.apiKeyEnv).toBe("GINI_LOCAL_API_KEY");
    expect(persisted.provider.extraBody).toBeUndefined();
  });

  test("flags can appear before or after the positional model name", async () => {
    const ctx = makeCtx([
      "provider", "set", "local",
      "--base-url", "http://127.0.0.1:8000/v1",
      "qwen3-test",
      "--api-key-env", "MY_KEY"
    ]);
    await provider(ctx);
    const cfgPath = join(process.env.GINI_STATE_ROOT!, "instances", "test-instance", "config.json");
    const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(persisted.provider.model).toBe("qwen3-test");
    expect(persisted.provider.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(persisted.provider.apiKeyEnv).toBe("MY_KEY");
  });

  test("--extra-body rejects non-object JSON", async () => {
    const ctx = makeCtx([
      "provider", "set", "local", "m",
      "--extra-body", JSON.stringify(["not", "an", "object"])
    ]);
    await expect(provider(ctx)).rejects.toThrow(/--extra-body must be a JSON object/);
  });

  test("--extra-body rejects malformed JSON", async () => {
    const ctx = makeCtx([
      "provider", "set", "local", "m",
      "--extra-body", "{this is not valid json"
    ]);
    await expect(provider(ctx)).rejects.toThrow(/--extra-body is not valid JSON/);
  });

  test("set rejects unknown provider names", async () => {
    const ctx = makeCtx(["provider", "set", "anthropic"]);
    await expect(provider(ctx)).rejects.toThrow(/Usage: gini provider set/);
  });

  test("set rejects unknown flags instead of silently ignoring them", async () => {
    // Previously, unknown flags were skipped without complaint and their
    // following token could become the model. The tightened parser surfaces
    // them so users see typos immediately.
    const ctx = makeCtx(["provider", "set", "local", "m", "--unknown-flag", "value"]);
    await expect(provider(ctx)).rejects.toThrow(/Unknown flag/);
  });

  test("set rejects a value-bearing flag with a missing value", async () => {
    // `--base-url` with no following token should fail loudly rather than
    // consuming the next positional and producing a confusing config.
    const ctx = makeCtx(["provider", "set", "local", "m", "--base-url"]);
    await expect(provider(ctx)).rejects.toThrow(/--base-url requires a value/);
  });

  test("set rejects a value-bearing flag whose value is another flag", async () => {
    // `--base-url --api-key-env X` would silently make "--api-key-env" the
    // base URL under the previous parser. Reject this.
    const ctx = makeCtx(["provider", "set", "local", "m", "--base-url", "--api-key-env", "FOO"]);
    await expect(provider(ctx)).rejects.toThrow(/--base-url requires a value/);
  });

  test("--extra-body with non-object JSON gets the right error (not the JSON-parse-error wrapper)", async () => {
    // Round-1 wrapped the shape error inside the JSON-parse catch, producing
    // the misleading "is not valid JSON: --extra-body must be a JSON object".
    // Now the error should be just "--extra-body must be a JSON object".
    const ctx = makeCtx(["provider", "set", "local", "m", "--extra-body", JSON.stringify(["a", "b"])]);
    await expect(provider(ctx)).rejects.toThrow(/^--extra-body must be a JSON object$/);
  });

  test("set rejects extra positional arguments", async () => {
    // Symmetric with the unknown-flag rejection: a typo like
    // `gini provider set local model-a model-b` shouldn't silently drop
    // `model-b`.
    const ctx = makeCtx(["provider", "set", "local", "model-a", "model-b"]);
    await expect(provider(ctx)).rejects.toThrow(/Unexpected extra argument/);
  });
});

function makeCtx(cliArgs: string[]): CliContext {
  const stateRoot = join(process.env.GINI_STATE_ROOT!, "instances", "test-instance");
  const config: RuntimeConfig = {
    instance: "test-instance",
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: join(stateRoot, "workspace"),
    stateRoot,
    logRoot: join(stateRoot, "logs")
  };
  return {
    config,
    cliArgs,
    command: cliArgs[0] ?? "",
    ephemeralSmoke: false,
    explicitInstance: true,
    rawArgs: cliArgs,
    web: { webPort: 0, webPortPinned: false, noWeb: true }
  };
}
