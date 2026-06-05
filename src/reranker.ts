// Cross-encoder reranker — final stage of the recall pipeline. After RRF
// fuses the four retrieval channels, the top-N candidates are scored by a
// cross-encoder (query, passage) pair, then re-sorted by that score.
//
// Three implementations, mirroring src/embeddings.ts:
//   - local:  in-process Transformers.js text-classification pipeline running
//             Xenova/ms-marco-MiniLM-L-6-v2 (~22M params, ~100MB ONNX). Pure
//             JS + native onnxruntime; no external service. Lazy-imports
//             `@huggingface/transformers` only on first use.
//   - echo:   deterministic stub for tests. Score = 1 / (1 + index). Pure
//             function of input position so test assertions are reproducible.
//   - none:   pass-through. The reranker is skipped entirely; RRF order
//             stands. Useful for users who want to disable reranking.
//
// Selection priority (mirrors embeddings):
//   1. GINI_RERANKER_PROVIDER env (explicit override) — local|echo|none
//   2. Default: local. If init fails, log a single warning and fall through
//      to none (recall still returns RRF-ordered results).
//
// Top-N controlled by GINI_RERANKER_TOP_N (default 25). Anything past that
// stays in RRF order — cross-encoder cost grows linearly with candidates,
// and tail entries rarely survive the token-budget filter anyway.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLocalModelCached } from "./local-model-cache";
import type { RuntimeConfig } from "./types";

// Default cross-encoder — `Xenova/ms-marco-MiniLM-L-6-v2`. The ms-marco
// variant of MiniLM-L6 is the canonical "small fast cross-encoder" in the
// Hindsight paper. ~22M params, ~100MB on disk.
export const DEFAULT_LOCAL_RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
export const DEFAULT_RERANKER_TOP_N = 25;

export interface Reranker {
  name: string;
  model: string;
  // Returns scores aligned with the input candidate order. Higher = more
  // relevant. Implementations must always return exactly `candidates.length`
  // entries so callers can zip back into their candidate list safely.
  score(query: string, candidates: string[]): Promise<number[]>;
}

export type RerankerProviderName = "local" | "echo" | "none";

// What `gini reranker status` and `gini doctor` need without instantiating
// anything heavyweight. Computed via resolveRerankerChoice.
export interface RerankerChoice {
  name: RerankerProviderName;
  model: string;
  reason: "explicit" | "default" | "fallback-none";
  topN: number;
  cacheDir?: string;
}

export function localCacheDir(): string {
  // Shared with embeddings — single cache dir for all local HF models so
  // `gini embedding status` and `gini reranker status` agree on disk usage.
  return join(homedir(), ".gini", "models");
}

export function rerankerTopN(): number {
  const raw = process.env.GINI_RERANKER_TOP_N;
  if (!raw) return DEFAULT_RERANKER_TOP_N;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RERANKER_TOP_N;
  return Math.floor(n);
}

function localModelId(): string {
  const override = process.env.GINI_LOCAL_RERANKER_MODEL;
  return override && override.length > 0 ? override : DEFAULT_LOCAL_RERANKER_MODEL;
}

// Pure-data view of the configured reranker choice. Doesn't trigger a model
// download; the caller must call `getReranker()` for that.
export function resolveRerankerChoice(_config: RuntimeConfig): RerankerChoice {
  const explicit = (process.env.GINI_RERANKER_PROVIDER ?? "").toLowerCase();
  const topN = rerankerTopN();
  if (explicit === "local") {
    return {
      name: "local",
      model: localModelId(),
      reason: "explicit",
      topN,
      cacheDir: localCacheDir()
    };
  }
  if (explicit === "echo") {
    return { name: "echo", model: "echo-rerank-v0", reason: "explicit", topN };
  }
  if (explicit === "none") {
    return { name: "none", model: "none", reason: "explicit", topN };
  }
  // Default is local. If init has previously failed in this process, the
  // status surface still reports the user-visible choice as "local" but
  // getReranker() falls through to the none provider.
  if (localProviderUnavailable) {
    return { name: "none", model: "none", reason: "fallback-none", topN };
  }
  return {
    name: "local",
    model: localModelId(),
    reason: "default",
    topN,
    cacheDir: localCacheDir()
  };
}

// Track local-provider load failures so we don't spam the same warning per
// rerank call. Once it fails, recall falls through to the none provider for
// the rest of the process lifetime.
let localProviderUnavailable: { reason: string } | null = null;

export function getReranker(config: RuntimeConfig): Reranker {
  const choice = resolveRerankerChoice(config);
  if (choice.name === "echo") return echoReranker();
  if (choice.name === "none") return noneReranker();
  // local — try it. If init has previously failed, fall through to none so
  // recall always gets a valid scorer.
  if (!localProviderUnavailable) {
    return localReranker(choice.model);
  }
  return noneReranker();
}

// --------------------------------------------------------------------------
// Local provider — in-process Transformers.js text-classification pipeline.
// --------------------------------------------------------------------------

// The cross-encoder is loaded as a `text-classification` pipeline; calling
// it with `{ text: query, text_pair: passage }` produces a single relevance
// logit which we treat as the rerank score. Transformers.js exposes the
// HuggingFace Xenova quantized ONNX builds at this path verbatim.
type TextClassificationOutput = Array<{ label: string; score: number }> | { label: string; score: number };
type TextClassifier = (
  inputs: { text: string; text_pair: string } | Array<{ text: string; text_pair: string }>,
  options?: { topk?: number | null }
) => Promise<TextClassificationOutput | TextClassificationOutput[]>;

const pipelineCache = new Map<string, Promise<TextClassifier>>();

// Test seam — replace the dynamic-import path so unit tests can exercise the
// local provider without touching the network or the native binding. Setting
// to null restores the real import.
type TransformersModule = {
  pipeline: (task: string, model: string) => Promise<TextClassifier>;
  env: { cacheDir?: string; allowRemoteModels?: boolean };
};
let transformersLoader: (() => Promise<TransformersModule>) | null = null;
export function __setTransformersLoaderForTests(loader: (() => Promise<TransformersModule>) | null): void {
  transformersLoader = loader;
  pipelineCache.clear();
  localProviderUnavailable = null;
}

async function loadTextClassifier(modelId: string): Promise<TextClassifier> {
  const existing = pipelineCache.get(modelId);
  if (existing) return existing;
  const promise = (async (): Promise<TextClassifier> => {
    const cacheDir = localCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    process.env.HF_HOME ??= cacheDir;
    process.env.TRANSFORMERS_CACHE ??= cacheDir;

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
      process.stderr.write(`Downloading reranker model ${modelId} (~100MB)... this happens once.\n`);
    }

    return await mod.pipeline("text-classification", modelId);
  })().catch((error) => {
    pipelineCache.delete(modelId);
    const message = error instanceof Error ? error.message : String(error);
    if (!localProviderUnavailable) {
      process.stderr.write(`Local reranker provider unavailable (${message}); falling back to none.\n`);
    }
    localProviderUnavailable = { reason: message };
    throw error;
  });
  pipelineCache.set(modelId, promise);
  return promise;
}

export function localReranker(modelId: string = localModelId()): Reranker {
  return {
    name: "local",
    model: modelId,
    async score(query: string, candidates: string[]): Promise<number[]> {
      if (candidates.length === 0) return [];
      let classifier: TextClassifier;
      try {
        classifier = await loadTextClassifier(modelId);
      } catch {
        // Init failed — fall through to a uniform pass-through score so
        // recall still returns RRF order rather than crashing. The warning
        // was emitted inside loadTextClassifier; downstream code uses the
        // none provider for subsequent calls.
        return candidates.map((_, i) => 1 / (1 + i));
      }
      // Pair-encode each (query, candidate). Calling the pipeline once per
      // pair is simpler than batching and avoids Transformers.js padding
      // surprises; cross-encoders are fast enough on small N (default 25).
      const out: number[] = new Array(candidates.length);
      for (let i = 0; i < candidates.length; i++) {
        const result = await classifier(
          { text: query, text_pair: candidates[i]! },
          { topk: null }
        );
        out[i] = extractScore(result);
      }
      return out;
    }
  };
}

function extractScore(result: TextClassificationOutput | TextClassificationOutput[]): number {
  // Transformers.js returns either a single {label, score} or an array; with
  // topk=null on a regression-style cross-encoder we typically get an array
  // of length 1. Be liberal in what we accept.
  if (Array.isArray(result)) {
    if (result.length === 0) return 0;
    const first = result[0]!;
    if (Array.isArray(first)) return extractScore(first);
    if (typeof first === "object" && first !== null && typeof (first as { score?: number }).score === "number") {
      return (first as { score: number }).score;
    }
    return 0;
  }
  if (typeof result === "object" && result !== null && typeof (result as { score?: number }).score === "number") {
    return (result as { score: number }).score;
  }
  return 0;
}

// --------------------------------------------------------------------------
// Echo provider — deterministic, content-independent. Score = 1/(1+index).
// Tests assert that the score field is set and reorders by the echo formula
// (which preserves input order; see recall.test.ts for the contract).
// --------------------------------------------------------------------------

export function echoReranker(): Reranker {
  return {
    name: "echo",
    model: "echo-rerank-v0",
    async score(_query: string, candidates: string[]): Promise<number[]> {
      return candidates.map((_, i) => 1 / (1 + i));
    }
  };
}

// --------------------------------------------------------------------------
// None provider — explicit pass-through. recall.ts checks the choice name
// and skips the rerank branch entirely when the active provider is `none`,
// so this implementation is mostly a safety net (in case a caller bypasses
// the skip and asks for scores). Returns 1/(1+index) so the original order
// is preserved if a caller does naively re-sort by the returned scores.
// --------------------------------------------------------------------------

export function noneReranker(): Reranker {
  return {
    name: "none",
    model: "none",
    async score(_query: string, candidates: string[]): Promise<number[]> {
      return candidates.map((_, i) => 1 / (1 + i));
    }
  };
}
