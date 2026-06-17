import { describe, expect, test } from "bun:test";
import {
  bedrockSupportsStreamingWithTools,
  bedrockSupportsToolUse,
  estimateUsd,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  resolveDefaultPriorContextTokenBudget,
  resolveImageByteLimit,
  resolveModelPricing,
  resolveProviderContextWindowTokens,
  resolveProviderModality
} from "./provider-capabilities";
import type { ProviderConfig } from "./types";

function provider(name: ProviderConfig["name"], model: string): ProviderConfig {
  return { name, model };
}

describe("resolveModelPricing", () => {
  test("routes representative model ids to the right per-million rates", () => {
    expect(resolveModelPricing(provider("anthropic", "claude-opus-4-8"))).toEqual({ inputPerMillion: 5, outputPerMillion: 25 });
    expect(resolveModelPricing(provider("anthropic", "claude-fable-5"))).toEqual({ inputPerMillion: 10, outputPerMillion: 50 });
    // Bedrock-prefixed ids resolve to the same first-party row.
    expect(resolveModelPricing(provider("bedrock", "us.anthropic.claude-sonnet-4-6"))).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
    expect(resolveModelPricing(provider("anthropic", "claude-haiku-4-5"))).toEqual({ inputPerMillion: 1, outputPerMillion: 5 });
  });

  test("orders specific patterns before broad ones", () => {
    // gpt-5 mini/nano must win over the broad gpt-5 row.
    expect(resolveModelPricing(provider("openai", "gpt-5.4-mini"))).toEqual({ inputPerMillion: 0.25, outputPerMillion: 2 });
    expect(resolveModelPricing(provider("codex", "gpt-5.5"))).toEqual({ inputPerMillion: 1.25, outputPerMillion: 10 });
    // deepseek-reasoner must win over the broad deepseek row.
    expect(resolveModelPricing(provider("openrouter", "deepseek-reasoner"))).toEqual({ inputPerMillion: 0.55, outputPerMillion: 2.19 });
    expect(resolveModelPricing(provider("openrouter", "deepseek-v4-flash"))).toEqual({ inputPerMillion: 0.27, outputPerMillion: 1.1 });
  });

  test("returns undefined for an unpriced or empty model", () => {
    expect(resolveModelPricing(provider("local", "some-unknown-model"))).toBeUndefined();
    expect(resolveModelPricing(provider("echo", ""))).toBeUndefined();
  });
});

describe("estimateUsd", () => {
  test("computes USD from input/output token counts at the model's rates", () => {
    // opus 4.8 = $5/$25 per MTok → 100 in + 20 out = $0.0005 + $0.0005 = $0.001.
    expect(estimateUsd(provider("anthropic", "claude-opus-4-8"), 100, 20)).toBeCloseTo(0.001, 9);
  });

  test("returns undefined (not 0) for an unpriced model so the figure stays absent", () => {
    expect(estimateUsd(provider("local", "unknown"), 1000, 1000)).toBeUndefined();
  });

  test("treats missing or non-finite token counts as zero", () => {
    expect(estimateUsd(provider("anthropic", "claude-opus-4-8"), undefined, undefined)).toBe(0);
    expect(estimateUsd(provider("anthropic", "claude-opus-4-8"), Number.NaN, 20)).toBeCloseTo(0.0005, 9);
  });
});

describe("resolveProviderModality", () => {
  test("known openai families support vision and native docs", () => {
    expect(resolveProviderModality(provider("openai", "gpt-5.5"))).toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openai", "gpt-4o"))).toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openai", "gpt-4.1-mini"))).toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openai", "o4-mini"))).toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openai", "ChatGPT-4o-latest"))).toEqual({ vision: true, nativeDocs: true });
  });

  test("unknown openai model ids fall back to conservative false", () => {
    // A custom OpenAI-compatible endpoint (or an unrecognized model) must not
    // be handed a document part it can't ingest.
    expect(resolveProviderModality(provider("openai", "llama-3-70b"))).toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openai", "text-davinci-003"))).toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openai", ""))).toEqual({ vision: false, nativeDocs: false });
    // Prefix collisions must NOT match a known family (no boundary → false).
    expect(resolveProviderModality(provider("openai", "gpt-5foo"))).toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openai", "gpt-4oish"))).toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openai", "o1derful"))).toEqual({ vision: false, nativeDocs: false });
  });

  test("openrouter supported families resolve to both true", () => {
    expect(resolveProviderModality(provider("openrouter", "anthropic/claude-3.7-sonnet")))
      .toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openrouter", "google/gemini-2.5-pro")))
      .toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openrouter", "openai/gpt-5.5")))
      .toEqual({ vision: true, nativeDocs: true });
  });

  test("openrouter is case-insensitive on the family prefix", () => {
    expect(resolveProviderModality(provider("openrouter", "Anthropic/Claude-3.7-Sonnet")))
      .toEqual({ vision: true, nativeDocs: true });
  });

  test("openrouter google family requires the gemini prefix, not just google/", () => {
    // google/gemma-* is text-only on OpenRouter; only google/gemini* is gated true.
    expect(resolveProviderModality(provider("openrouter", "google/gemma-3-27b")))
      .toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openrouter", "google/gemini-1.5-flash")))
      .toEqual({ vision: true, nativeDocs: true });
  });

  test("openrouter unknown/other routed models fall back to conservative false", () => {
    expect(resolveProviderModality(provider("openrouter", "meta-llama/llama-3.3-70b-instruct")))
      .toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openrouter", "deepseek/deepseek-chat")))
      .toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openrouter", "")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("deepseek is text-only", () => {
    expect(resolveProviderModality(provider("deepseek", "deepseek-chat")))
      .toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("deepseek", "deepseek-reasoner")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("codex is natively multimodal (verified against the live backend)", () => {
    expect(resolveProviderModality(provider("codex", "gpt-5.5")))
      .toEqual({ vision: true, nativeDocs: true });
  });

  test("azure follows the openai model family for vision but never native docs", () => {
    // Azure's deployment-scoped chat/completions has no `file` content part, so
    // nativeDocs stays false even for a vision-capable family.
    expect(resolveProviderModality(provider("azure", "gpt-4o")))
      .toEqual({ vision: true, nativeDocs: false });
    expect(resolveProviderModality(provider("azure", "gpt-5.5")))
      .toEqual({ vision: true, nativeDocs: false });
    // An unknown/text-only Azure deployment stays conservatively false on both.
    expect(resolveProviderModality(provider("azure", "text-embedding-3-large")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("local is conservatively unknown → false", () => {
    expect(resolveProviderModality(provider("local", "local/default")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("echo has no modality", () => {
    expect(resolveProviderModality(provider("echo", "gini-echo-v0")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("an unknown provider name resolves to the conservative default", () => {
    expect(resolveProviderModality({ name: "mystery" as ProviderConfig["name"], model: "x" }))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("bedrock: vision is per-model, nativeDocs always false (Converse sends no document blocks)", () => {
    // Multimodal families → vision true.
    for (const m of [
      "us.anthropic.claude-opus-4-8",
      "us.amazon.nova-pro-v1:0",
      "us.amazon.nova-lite-v1:0",
      "us.mistral.pixtral-large-2502-v1:0",
      "us.meta.llama4-maverick-17b-instruct-v1:0",
      "us.meta.llama3-2-11b-instruct-v1:0"
    ]) {
      expect(resolveProviderModality(provider("bedrock", m))).toEqual({ vision: true, nativeDocs: false });
    }
    // Text-only / unrecognized ids → vision false. nativeDocs is false either way.
    for (const m of ["us.deepseek.r1-v1:0", "us.meta.llama3-3-70b-instruct-v1:0", "us.amazon.nova-micro-v1:0", ""]) {
      expect(resolveProviderModality(provider("bedrock", m))).toEqual({ vision: false, nativeDocs: false });
    }
  });
});

describe("bedrockSupportsToolUse", () => {
  test("DeepSeek ids are gated off; every other catalog family stays on", () => {
    // DeepSeek R1 returns a ValidationException when sent a Converse toolConfig.
    expect(bedrockSupportsToolUse("us.deepseek.r1-v1:0")).toBe(false);
    expect(bedrockSupportsToolUse("DeepSeek-R1")).toBe(false);
    // Tool-capable families default to true (incl. unrecognized/custom ids).
    for (const m of [
      "us.anthropic.claude-opus-4-8",
      "us.amazon.nova-micro-v1:0",
      "us.meta.llama3-3-70b-instruct-v1:0",
      "us.mistral.mistral-large-2407-v1:0",
      "some.custom.future-model",
      ""
    ]) {
      expect(bedrockSupportsToolUse(m)).toBe(true);
    }
  });
});

describe("bedrockSupportsStreamingWithTools", () => {
  test("Llama 4 ids are gated off; every other family streams with tools", () => {
    // Llama 4 can't carry toolConfig on a streaming request ("tool use in
    // streaming mode"); callBedrockConverse drops to non-stream only when tools
    // are attached.
    expect(bedrockSupportsStreamingWithTools("us.meta.llama4-maverick-17b-instruct-v1:0")).toBe(false);
    expect(bedrockSupportsStreamingWithTools("us.meta.llama4-scout-17b-instruct-v1:0")).toBe(false);
    // Other families (incl. Llama 3.3, unrecognized/custom ids) support tools + streaming.
    for (const m of [
      "us.anthropic.claude-opus-4-8",
      "us.amazon.nova-lite-v1:0",
      "us.meta.llama3-3-70b-instruct-v1:0",
      "us.deepseek.r1-v1:0",
      "some.custom.future-model",
      ""
    ]) {
      expect(bedrockSupportsStreamingWithTools(m)).toBe(true);
    }
  });
});

describe("resolveProviderContextWindowTokens", () => {
  test("openai known model families resolve to their context windows", () => {
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.5"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.4"))).toBe(1_050_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.4-mini"))).toBe(400_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.3-codex-spark"))).toBe(400_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.2-chat-latest"))).toBe(128_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-4.1-mini"))).toBe(1_047_576);
    expect(resolveProviderContextWindowTokens(provider("openai", "o4-mini"))).toBe(200_000);
  });

  test("codex caps at the backend context window even when the model's nominal window is larger", () => {
    // gpt-5.5 is 1M on the direct OpenAI API but only 275k through the Codex
    // backend; openai must stay unchanged at the model's nominal window.
    expect(resolveProviderContextWindowTokens(provider("codex", "gpt-5.5"))).toBe(275_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.5"))).toBe(1_000_000);
  });

  test("azure resolves context windows by the underlying openai model family", () => {
    expect(resolveProviderContextWindowTokens(provider("azure", "gpt-5.5"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("azure", "gpt-4.1-mini"))).toBe(1_047_576);
    expect(resolveProviderContextWindowTokens(provider("azure", "o4-mini"))).toBe(200_000);
  });

  test("deepseek v4 models and compatibility aliases resolve to one million tokens", () => {
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-v4-flash"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-v4-pro"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-chat"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-reasoner"))).toBe(1_000_000);
  });

  test("openrouter routed slugs reuse known upstream windows where possible", () => {
    expect(resolveProviderContextWindowTokens(provider("openrouter", "openai/gpt-5.4-mini"))).toBe(400_000);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "deepseek/deepseek-v4-flash"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "anthropic/claude-4-sonnet"))).toBe(200_000);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "google/gemini-2.5-pro"))).toBe(1_000_000);
  });

  test("anthropic + bedrock map to real per-model windows, not the 32K fallback", () => {
    // 1M-context Claude families: Opus 4.6+, Sonnet 4.6, Fable 5 — on first-party
    // and on Bedrock inference profiles alike.
    expect(resolveProviderContextWindowTokens(provider("anthropic", "claude-opus-4-8"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("anthropic", "claude-sonnet-4-6"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("anthropic", "claude-fable-5"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.anthropic.claude-opus-4-8"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "anthropic/claude-opus-4-8"))).toBe(1_000_000);
    // Haiku 4.5 and older Opus/Sonnet point releases keep the 200K window.
    expect(resolveProviderContextWindowTokens(provider("anthropic", "claude-haiku-4-5"))).toBe(200_000);
    expect(resolveProviderContextWindowTokens(provider("anthropic", "claude-opus-4-5"))).toBe(200_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.anthropic.claude-haiku-4-5"))).toBe(200_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.amazon.nova-premier-v1:0"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.amazon.nova-pro-v1:0"))).toBe(300_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "eu.amazon.nova-lite-v1:0"))).toBe(300_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.amazon.nova-micro-v1:0"))).toBe(128_000);
    // Unrecognized families on each provider stay conservative.
    expect(resolveProviderContextWindowTokens(provider("anthropic", "mystery-model"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.meta.llama3-3-70b-instruct-v1:0"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });

  test("unknown, local, echo, and openrouter auto fall back conservatively", () => {
    expect(resolveProviderContextWindowTokens(provider("openai", "llama-3-70b"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens(provider("local", "local/default"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens(provider("echo", "gini-echo-v0"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "openrouter/auto"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens({ name: "mystery" as ProviderConfig["name"], model: "x" }))
      .toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });
});

describe("resolveImageByteLimit", () => {
  test("raw budget stays under the provider base64 cap once encoded", () => {
    // Anthropic/Bedrock cap the base64-encoded `image.source.base64` payload at
    // 5,242,880, not the raw bytes. base64 length = 4 * ceil(n / 3), so a raw
    // limit must satisfy that the encoded form is <= the cap.
    const limit = resolveImageByteLimit(provider("bedrock", "us.anthropic.claude-opus-4-8"));
    expect(limit).toBeGreaterThan(0);
    const encodedLength = 4 * Math.ceil(limit / 3);
    expect(encodedLength).toBeLessThanOrEqual(5_242_880);
  });
});

describe("resolveDefaultPriorContextTokenBudget", () => {
  test("defaults to sixty-five percent of the provider context window", () => {
    // codex gpt-5.5 budgets against the 275k backend cap, not the 1M nominal window.
    expect(resolveDefaultPriorContextTokenBudget(provider("codex", "gpt-5.5"))).toBe(178_750);
    expect(resolveDefaultPriorContextTokenBudget(provider("openai", "gpt-5.5"))).toBe(650_000);
    expect(resolveDefaultPriorContextTokenBudget(provider("openai", "gpt-5.4-mini"))).toBe(260_000);
    expect(resolveDefaultPriorContextTokenBudget(provider("openai", "gpt-4.1-mini"))).toBe(680_924);
    expect(resolveDefaultPriorContextTokenBudget(provider("echo", "gini-echo-v0"))).toBe(20_800);
  });
});
