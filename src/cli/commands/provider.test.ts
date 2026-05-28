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
    // Easy mistake: throw the shape error inside the JSON.parse catch,
    // which wraps it as "is not valid JSON: --extra-body must be a JSON
    // object". Parse and shape-validate are kept separate so non-object
    // JSON reports its own error verbatim.
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

  // ---------------- warning-surface tests ----------------
  // The CLI warns when a flag is passed for a provider that doesn't honor
  // it. Codex DOES honor --base-url (the backend URL) and --api-key-env
  // (codexAuthPath reads process.env[apiKeyEnv]); only --extra-body is
  // dropped for codex because /responses uses a different request shape.
  // Echo bypasses HTTP entirely and ignores all three. These tests pin
  // the warning surface so the precise per-provider behavior can't drift.

  test("echo provider warns for every ignored flag (none of them apply)", async () => {
    // Echo bypasses HTTP entirely, so every flag that configures a
    // wire request (--base-url, --api-key-env, --extra-body,
    // --prompt-cache-retention) should be reported as ignored. Pin
    // each flag explicitly so a future ignored-list entry that drops
    // a flag (or a future flag added to ignored without being added
    // to this assertion) gets caught here.
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const ctx = makeCtx([
        "provider", "set", "echo", "gini-echo-v0",
        "--base-url", "http://x/v1",
        "--api-key-env", "FOO",
        "--extra-body", "{}",
        "--prompt-cache-retention", "24h"
      ]);
      await provider(ctx);
    } finally {
      process.stderr.write = original;
    }
    const msg = captured.join("");
    expect(msg).toContain("--base-url");
    expect(msg).toContain("--api-key-env");
    expect(msg).toContain("--extra-body");
    expect(msg).toContain("--prompt-cache-retention");
    expect(msg).toContain("echo provider");
  });

  test("codex provider warns ONLY for --extra-body (it honors --base-url and --api-key-env)", async () => {
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const ctx = makeCtx([
        "provider", "set", "codex", "gpt-5.5",
        "--base-url", "http://example/v1",
        "--api-key-env", "MY_CODEX_AUTH",
        "--extra-body", "{}"
      ]);
      await provider(ctx);
    } finally {
      process.stderr.write = original;
    }
    const msg = captured.join("");
    expect(msg).toContain("--extra-body");
    expect(msg).toContain("codex provider");
    expect(msg).not.toContain("--base-url");
    expect(msg).not.toContain("--api-key-env");
  });

  test("codex with --base-url and --api-key-env (no --extra-body) emits NO warning", async () => {
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const ctx = makeCtx([
        "provider", "set", "codex", "gpt-5.5",
        "--base-url", "http://example/v1",
        "--api-key-env", "MY_CODEX_AUTH"
      ]);
      await provider(ctx);
    } finally {
      process.stderr.write = original;
    }
    expect(captured.join("")).toBe("");
  });

  test("--prompt-cache-retention persists the value on the typed field", async () => {
    const ctx = makeCtx([
      "provider", "set", "openai", "gpt-5.5",
      "--prompt-cache-retention", "24h"
    ]);
    await provider(ctx);
    const cfgPath = join(process.env.GINI_STATE_ROOT!, "instances", "test-instance", "config.json");
    const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(persisted.provider.promptCacheRetention).toBe("24h");
  });

  test("--prompt-cache-retention empty string clears the field", async () => {
    // First set 24h, then clear via empty string. The resolver treats
    // empty-string the same as omitting the field; persisting an empty
    // value would round-trip as a stale "still set" signal, so the
    // clear must remove the field entirely from the persisted shape.
    await provider(makeCtx([
      "provider", "set", "openai", "gpt-5.5",
      "--prompt-cache-retention", "24h"
    ]));
    await provider(makeCtx([
      "provider", "set", "openai", "gpt-5.5",
      "--prompt-cache-retention", ""
    ]));
    const cfgPath = join(process.env.GINI_STATE_ROOT!, "instances", "test-instance", "config.json");
    const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(persisted.provider.promptCacheRetention).toBeUndefined();
  });

  test("subsequent set without --prompt-cache-retention carries the previous value forward", async () => {
    // ZDR-relevant carry-forward: an operator that opted into "24h"
    // and then runs `gini provider set openai gpt-5.4` to swap models
    // must not silently lose their retention bucket. This is the
    // shape every rebuild site in the runtime guards (CLI provider,
    // CLI setup, web setup-api, admin install).
    await provider(makeCtx([
      "provider", "set", "openai", "gpt-5.5",
      "--prompt-cache-retention", "24h"
    ]));
    // Each `gini provider set` invocation in production is a fresh
    // process that loads config from disk before running. Mirror that
    // here so the second call's carry-forward sees the previously-
    // persisted value rather than the test-helper's stub provider.
    const cfgPath = join(process.env.GINI_STATE_ROOT!, "instances", "test-instance", "config.json");
    const reloaded = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    const ctx2 = makeCtx(["provider", "set", "openai", "gpt-5.4"]);
    ctx2.config.provider = reloaded.provider;
    await provider(ctx2);
    const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(persisted.provider.model).toBe("gpt-5.4");
    expect(persisted.provider.promptCacheRetention).toBe("24h");
  });

  test("switching provider drops a previous same-provider retention setting", async () => {
    // Cross-provider rewrites (openai → openrouter, etc.) must NOT
    // carry the retention bucket — openrouter may not even recognize
    // the field, and the operator's opt-in was provider-scoped.
    await provider(makeCtx([
      "provider", "set", "openai", "gpt-5.5",
      "--prompt-cache-retention", "24h"
    ]));
    const cfgPath = join(process.env.GINI_STATE_ROOT!, "instances", "test-instance", "config.json");
    const reloaded = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    const ctx2 = makeCtx(["provider", "set", "openrouter", "openai/gpt-4o"]);
    ctx2.config.provider = reloaded.provider;
    await provider(ctx2);
    const persisted = JSON.parse(readFileSync(cfgPath, "utf8")) as RuntimeConfig;
    expect(persisted.provider.name).toBe("openrouter");
    expect(persisted.provider.promptCacheRetention).toBeUndefined();
  });

  test("codex --prompt-cache-retention emits a backend-rejects warning", async () => {
    // The chatgpt.com codex backend rejects the field with HTTP 400.
    // The CLI forwards the value anyway so a future backend update
    // works without a code change, but warns loudly so the operator
    // understands every outbound request will fail until the backend
    // adds support.
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const ctx = makeCtx([
        "provider", "set", "codex", "gpt-5.5",
        "--prompt-cache-retention", "24h"
      ]);
      await provider(ctx);
    } finally {
      process.stderr.write = original;
    }
    expect(captured.join("")).toMatch(/chatgpt\.com codex backend currently rejects/);
  });

  test("local provider with every flag emits NO warning (every flag applies)", async () => {
    // local routes through chat-completions and honors all four
    // configurable flags: --base-url, --api-key-env, --extra-body,
    // and --prompt-cache-retention. Pin the empty-warning contract on
    // the full flag set so a future ignored-list entry that incorrectly
    // adds local to one of the warning branches is caught here.
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const ctx = makeCtx([
        "provider", "set", "local", "m",
        "--base-url", "http://x/v1",
        "--api-key-env", "FOO",
        "--extra-body", "{}",
        "--prompt-cache-retention", "24h"
      ]);
      await provider(ctx);
    } finally {
      process.stderr.write = original;
    }
    expect(captured.join("")).toBe("");
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
