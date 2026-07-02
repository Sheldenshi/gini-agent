// Embedding provider abstraction.
//
// Three implementations:
//   - local:  in-process Transformers.js (ONNX), default model
//             Xenova/all-MiniLM-L6-v2 (384d). Pure JS + native onnxruntime;
//             no external service. Lazy-imports `@huggingface/transformers`
//             only on first use so users on openai/echo never pay the
//             native-binding load cost.
//   - openai: text-embedding-3-small (dim=1536), batched up to 100 inputs.
//             Reuses the same bearer-token resolution as src/provider.ts so
//             both OPENAI_API_KEY and Codex OAuth tokens work.
//   - echo:   deterministic hash-based 32-dim vector. Identical input always
//             produces an identical vector — what tests need.
//
// Selection priority (per the local-embeddings brief):
//   1. GINI_EMBEDDING_PROVIDER env (explicit override) — local|openai|echo
//   2. local (lazy-init; if Transformers.js fails to import or load, fall
//      through with a one-line stderr warning)
//   3. openai (if a bearer is reachable)
//   4. echo
//
// Different providers/models live in different vector spaces — cosine across
// them is meaningless. The `embedding_model` column on memory_units lets
// recall.ts filter to vectors emitted by the current provider's model. The
// `gini embedding reembed` CLI walks units and re-embeds them with the
// active provider so semantic recall picks them up after a provider switch.
//
// In-process cache keyed by (model, text) avoids re-embedding the same
// string twice within a single CLI/runtime process — retain-then-recall in
// the same process commonly hits the same query, and the cache shaves a
// network round-trip without persistence concerns.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isLocalModelCached } from "./local-model-cache";
import type { RuntimeConfig } from "./types";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OPENAI_EMBEDDING_DIM = 1536;
const ECHO_DIM = 32;
const DEFAULT_BATCH_SIZE = 100;

// Default local model — small (~25MB), 384d, fast on M-series. Override with
// GINI_LOCAL_EMBEDDING_MODEL for a bigger/different SBERT-style encoder.
export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_LOCAL_EMBEDDING_DIM = 384;

export interface EmbeddingProvider {
  name: string;
  model: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export type EmbeddingProviderName = "local" | "openai" | "echo";

// What `gini embedding status` and `gini doctor` need to know without
// instantiating anything heavyweight. Computed via resolveEmbeddingChoice.
export interface EmbeddingChoice {
  name: EmbeddingProviderName;
  model: string;
  reason: "explicit" | "default" | "fallback-openai" | "fallback-echo";
  cacheDir?: string;
}

export function localCacheDir(): string {
  return join(homedir(), ".gini", "models");
}

// Pure-data view of the configured embedding choice. Doesn't trigger a
// model download; the caller must call `getEmbeddingProvider()` for that.
export function resolveEmbeddingChoice(config: RuntimeConfig): EmbeddingChoice {
  const explicit = (process.env.GINI_EMBEDDING_PROVIDER ?? "").toLowerCase();
  if (explicit === "local") {
    return {
      name: "local",
      model: localModelId(),
      reason: "explicit",
      cacheDir: localCacheDir()
    };
  }
  if (explicit === "openai") {
    return { name: "openai", model: DEFAULT_OPENAI_EMBEDDING_MODEL, reason: "explicit" };
  }
  if (explicit === "echo") {
    return { name: "echo", model: "echo-embed-v0", reason: "explicit" };
  }
  // Default is local. The hard-rule from the brief: "default must be local".
  return {
    name: "local",
    model: localModelId(),
    reason: "default",
    cacheDir: localCacheDir()
  };
}

function localModelId(): string {
  const override = process.env.GINI_LOCAL_EMBEDDING_MODEL;
  return override && override.length > 0 ? override : DEFAULT_LOCAL_EMBEDDING_MODEL;
}

// Track local-provider load failures so we don't spam the same warning per
// embed call. Once it fails, callers fall back to openai/echo for the rest
// of the process lifetime.
let localProviderUnavailable: { reason: string } | null = null;

export function getEmbeddingProvider(config: RuntimeConfig): EmbeddingProvider {
  const choice = resolveEmbeddingChoice(config);
  if (choice.name === "echo") return echoProvider();
  if (choice.name === "openai") return openaiProvider(config);

  // local — try it. If init has previously failed, fall through.
  if (!localProviderUnavailable) {
    return localProvider(choice.model);
  }
  // Fall-through warned once; pick the next-best option without nagging.
  if (resolveOpenAIBearer(config) || readCodexBearerOrNull(config)) {
    return openaiProvider(config);
  }
  return echoProvider();
}

// --------------------------------------------------------------------------
// Local provider — in-process Transformers.js feature-extraction pipeline.
// --------------------------------------------------------------------------

// Pipeline factories cached per-model so multiple instances share a single
// loaded model. Keyed by model id; value is a promise so concurrent callers
// during cold start don't double-load.
type FeatureExtractor = (text: string | string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;
const pipelineCache = new Map<string, Promise<FeatureExtractor>>();

// Test seam — replace the dynamic-import path so unit tests can exercise the
// local provider without touching the network or the native binding. Setting
// to null restores the real import.
type TransformersModule = {
  pipeline: (task: string, model: string) => Promise<FeatureExtractor>;
  env: { cacheDir?: string; allowRemoteModels?: boolean };
};
let transformersLoader: (() => Promise<TransformersModule>) | null = null;
export function __setTransformersLoaderForTests(loader: (() => Promise<TransformersModule>) | null): void {
  transformersLoader = loader;
  pipelineCache.clear();
  localProviderUnavailable = null;
}

async function loadFeatureExtractor(modelId: string): Promise<FeatureExtractor> {
  const existing = pipelineCache.get(modelId);
  if (existing) return existing;
  const promise = (async (): Promise<FeatureExtractor> => {
    // Cache directory: ~/.gini/models. We set this on env BEFORE the dynamic
    // import resolves (the module reads env at instantiation time but tolerates
    // post-import mutation too — we set both env and the module field).
    const cacheDir = localCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    process.env.HF_HOME ??= cacheDir;
    process.env.TRANSFORMERS_CACHE ??= cacheDir;

    // Never import the real module under bun test: it dlopens the
    // onnxruntime NAPI addon, whose deferred finalizers can fire after a
    // --parallel/--isolate worker has swapped globals and segfault the
    // worker (napi_open_escapable_handle_scope; surfaced via issue #289).
    // Tests that exercise this path inject __setTransformersLoaderForTests;
    // everything else degrades through the catch below, same as a failed
    // model load in production.
    if (!transformersLoader && process.env.NODE_ENV === "test") {
      throw new Error("@huggingface/transformers is not loaded under bun test; inject __setTransformersLoaderForTests");
    }
    const mod = transformersLoader
      ? await transformersLoader()
      : (await import("@huggingface/transformers")) as unknown as TransformersModule;
    if (mod.env) mod.env.cacheDir = cacheDir;

    // First-use download notice. Transformers.js nests the model under
    // <cacheDir>/<org>/<model>/, so checking that nested directory (not a flat
    // top-level scan) tells us whether this model is already cached and the
    // notice should print.
    const looksUncached = !isLocalModelCached(cacheDir, modelId);
    if (looksUncached) {
      process.stderr.write(`Downloading embedding model ${modelId} (~25MB)... this happens once.\n`);
    }

    return await mod.pipeline("feature-extraction", modelId);
  })().catch((error) => {
    // Surface a one-line warning on first failure so the user knows local
    // fell through. Subsequent calls quietly use the fallback.
    pipelineCache.delete(modelId);
    const message = error instanceof Error ? error.message : String(error);
    if (!localProviderUnavailable) {
      process.stderr.write(`Local embedding provider unavailable (${message}); falling back.\n`);
    }
    localProviderUnavailable = { reason: message };
    throw error;
  });
  pipelineCache.set(modelId, promise);
  return promise;
}

export function localProvider(modelId: string = localModelId()): EmbeddingProvider {
  // Cache (model, text) -> vector at the provider level. A fact often gets
  // re-embedded later in the same process (e.g. retain → recall), and local
  // embedding is fast but not free.
  const cache = new Map<string, Float32Array>();
  return {
    name: "local",
    model: modelId,
    // We don't *strictly* know the dim until the model loads, but the default
    // Xenova/all-MiniLM-L6-v2 is 384d; status surfaces will report this and
    // the actual dim is captured per-vector at insert time anyway.
    dim: DEFAULT_LOCAL_EMBEDDING_DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const out: Float32Array[] = new Array(texts.length);
      const misses: { index: number; text: string }[] = [];
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i]!;
        const cached = cache.get(text);
        if (cached) out[i] = cached;
        else misses.push({ index: i, text });
      }
      if (misses.length > 0) {
        const extractor = await loadFeatureExtractor(modelId);
        for (const slot of misses) {
          const result = await extractor(slot.text, { pooling: "mean", normalize: true });
          // Result data is a typed array view onto a shared ArrayBuffer; copy
          // so subsequent calls don't overwrite earlier results.
          const copy = new Float32Array(result.data.length);
          copy.set(result.data);
          out[slot.index] = copy;
          cache.set(slot.text, copy);
        }
      }
      return out;
    }
  };
}

// --------------------------------------------------------------------------
// Echo provider — deterministic hash-based stub for tests + offline dev.
// --------------------------------------------------------------------------

export function echoProvider(): EmbeddingProvider {
  return {
    name: "echo",
    model: "echo-embed-v0",
    dim: ECHO_DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => echoEmbed(text));
    }
  };
}

// Token-level FNV-1a hashing into a fixed-dim bag. Each token contributes a
// +1 to its hashed slot. Lowercased + alphanumeric-only token split keeps
// the vector stable across small textual variations (whitespace, punctuation,
// casing). Identical inputs -> identical vectors; near-duplicate inputs ->
// near-identical vectors with cosine close to 1.
export function echoEmbed(text: string): Float32Array {
  const out = new Float32Array(ECHO_DIM);
  if (text.length === 0) {
    out[0] = 1;
    return normalize(out);
  }
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) {
    out[0] = 1;
    return normalize(out);
  }
  for (const token of tokens) {
    let hash = 2166136261 >>> 0;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    const slot = hash % ECHO_DIM;
    out[slot] += 1;
  }
  return normalize(out);
}

function normalize(vector: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vector.length; i++) sumSq += vector[i]! * vector[i]!;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / norm;
  return vector;
}

// --------------------------------------------------------------------------
// OpenAI provider
// --------------------------------------------------------------------------

export function openaiProvider(config: RuntimeConfig): EmbeddingProvider {
  const cache = new Map<string, Float32Array>();
  return {
    name: "openai",
    model: DEFAULT_OPENAI_EMBEDDING_MODEL,
    dim: DEFAULT_OPENAI_EMBEDDING_DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const out: Float32Array[] = new Array(texts.length);
      const misses: { index: number; text: string }[] = [];
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i]!;
        const cached = cache.get(text);
        if (cached) out[i] = cached;
        else misses.push({ index: i, text });
      }
      // Batch misses.
      for (let start = 0; start < misses.length; start += DEFAULT_BATCH_SIZE) {
        const slice = misses.slice(start, start + DEFAULT_BATCH_SIZE);
        const vectors = await embedOpenAIBatch(config, slice.map((m) => m.text));
        for (let j = 0; j < slice.length; j++) {
          const slot = slice[j]!;
          const vector = vectors[j]!;
          out[slot.index] = vector;
          cache.set(slot.text, vector);
        }
      }
      return out;
    }
  };
}

async function embedOpenAIBatch(config: RuntimeConfig, texts: string[]): Promise<Float32Array[]> {
  const bearer = resolveOpenAIBearer(config) ?? readCodexBearerOrNull(config);
  if (!bearer) {
    throw new Error("OpenAI embedding provider requires OPENAI_API_KEY or Codex OAuth credentials.");
  }
  const baseUrl = openAIEmbeddingBaseUrl(config);
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: DEFAULT_OPENAI_EMBEDDING_MODEL,
      input: texts
    })
  });
  const raw = await response.text();
  if (!response.ok) {
    let message = `Embedding request failed with HTTP ${response.status}`;
    try {
      const payload = JSON.parse(raw) as { error?: { message?: unknown } };
      if (payload.error && typeof payload.error.message === "string") message = payload.error.message;
    } catch {
      message = raw.slice(0, 500) || message;
    }
    throw new Error(message);
  }
  const payload = JSON.parse(raw) as { data?: Array<{ embedding?: number[]; index?: number }> };
  const data = payload.data ?? [];
  const out: Float32Array[] = new Array(texts.length);
  for (const entry of data) {
    const idx = typeof entry.index === "number" ? entry.index : -1;
    if (idx < 0 || idx >= texts.length) continue;
    const vector = new Float32Array(entry.embedding ?? []);
    out[idx] = vector;
  }
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) throw new Error("OpenAI embeddings response missing entry for input ${i}");
  }
  return out;
}

// Chat providers whose configured baseUrl/apiKeyEnv also speak the OpenAI
// /embeddings wire shape, so the embedding path may reuse them. Every other
// active chat provider (anthropic, bedrock, codex, echo) routes to a host with
// no OpenAI /embeddings endpoint, so reusing its baseUrl/key would mis-route
// the request and leak the chat key to that host (e.g. the Anthropic key to
// api.anthropic.com/embeddings). Those fall back to the canonical OpenAI
// endpoint + OPENAI_API_KEY instead.
const OPENAI_EMBEDDING_COMPATIBLE = new Set(["openai", "openrouter", "deepseek", "local"]);

function openAIEmbeddingBaseUrl(config: RuntimeConfig): string {
  const reuse = OPENAI_EMBEDDING_COMPATIBLE.has(config.provider.name) && config.provider.baseUrl;
  return (reuse ? config.provider.baseUrl! : DEFAULT_OPENAI_BASE_URL).replace(/\/$/, "");
}

// --------------------------------------------------------------------------
// Bearer-token resolution (mirrors src/provider.ts but tolerant of missing
// creds — getEmbeddingProvider auto-selects only when one of these resolves).
// --------------------------------------------------------------------------

function resolveOpenAIBearer(config: RuntimeConfig): string | null {
  // Borrow the chat provider's key only for OpenAI-compatible providers; for
  // anthropic/bedrock/codex/echo use OPENAI_API_KEY so the embedding call never
  // sends a non-OpenAI key to api.openai.com (or the chat key to a non-OpenAI
  // host via openAIEmbeddingBaseUrl).
  const envName =
    OPENAI_EMBEDDING_COMPATIBLE.has(config.provider.name) && config.provider.apiKeyEnv
      ? config.provider.apiKeyEnv
      : "OPENAI_API_KEY";
  const value = process.env[envName];
  return value && value.length > 0 ? value : null;
}

function readCodexBearerOrNull(config: RuntimeConfig): string | null {
  // Only the codex provider's apiKeyEnv names a CODEX_AUTH_JSON-style path. For
  // any other active provider, apiKeyEnv holds a SECRET key env (e.g.
  // ANTHROPIC_API_KEY → "sk-ant-…"), so honoring it here would resolve to a
  // nonsense path AND short-circuit past CODEX_AUTH_JSON. Mirror codexAuthPath
  // in src/provider.ts — gate on the codex provider.
  const envName = config.provider.name === "codex" ? config.provider.apiKeyEnv : undefined;
  const envValue = envName ? process.env[envName] : undefined;
  const raw = envValue || process.env.CODEX_AUTH_JSON || "~/.codex/auth.json";
  const path = resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const apiKey = typeof parsed.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY : null;
    if (apiKey) return apiKey;
    const tokens = parsed.tokens && typeof parsed.tokens === "object"
      ? parsed.tokens as Record<string, unknown>
      : null;
    const access = tokens && typeof tokens.access_token === "string" ? tokens.access_token : null;
    return access;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Cosine similarity helper — used by retain (semantic links) and recall
// (semantic channel). Lives here so vector math has a single home.
// --------------------------------------------------------------------------

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
