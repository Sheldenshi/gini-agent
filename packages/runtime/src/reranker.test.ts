// Reranker-provider selection-logic + per-provider tests.
//
// These tests must never pull a real model from the hub: we stub the
// dynamic import via __setTransformersLoaderForTests so the local-provider
// code path runs without the network or the native binding.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  __setTransformersLoaderForTests,
  DEFAULT_LOCAL_RERANKER_MODEL,
  DEFAULT_RERANKER_TOP_N,
  echoReranker,
  getReranker,
  localReranker,
  noneReranker,
  rerankerTopN,
  resolveRerankerChoice
} from "./reranker";
import type { RuntimeConfig } from "./types";

const ROOT = "/tmp/gini-reranker-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  __setTransformersLoaderForTests(null);
});

afterEach(() => {
  delete process.env.GINI_RERANKER_PROVIDER;
  delete process.env.GINI_LOCAL_RERANKER_MODEL;
  delete process.env.GINI_RERANKER_TOP_N;
  __setTransformersLoaderForTests(null);
});

function makeConfig(): RuntimeConfig {
  return {
    instance: "rerank-test",
    port: 0,
    token: "t",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

// Builds a fake @huggingface/transformers module so getReranker's local
// path executes end-to-end without the real native binding. The stub
// classifier returns a score equal to the candidate's character length so
// tests can assert deterministic, predictable reordering.
function makeFakeTransformers(modelId: string, mode: "ok" | "throw" = "ok") {
  const env: Record<string, unknown> = { cacheDir: "" };
  return {
    pipeline: async (task: string, model: string) => {
      expect(task).toBe("text-classification");
      expect(model).toBe(modelId);
      if (mode === "throw") throw new Error("fake init failure");
      return async (
        inputs: { text: string; text_pair: string } | Array<{ text: string; text_pair: string }>,
        _options?: { topk?: number | null }
      ) => {
        const single = Array.isArray(inputs) ? inputs[0]! : inputs;
        // Score = length of the candidate. Predictable + content-dependent
        // so reordering is observable in tests.
        return [{ label: "LABEL_0", score: single.text_pair.length }];
      };
    },
    env
  };
}

describe("resolveRerankerChoice", () => {
  test("default (no env) is local with the default model", () => {
    const config = makeConfig();
    const choice = resolveRerankerChoice(config);
    expect(choice.name).toBe("local");
    expect(choice.model).toBe(DEFAULT_LOCAL_RERANKER_MODEL);
    expect(choice.reason).toBe("default");
    expect(choice.topN).toBe(DEFAULT_RERANKER_TOP_N);
  });

  test("explicit GINI_RERANKER_PROVIDER=local pins local", () => {
    process.env.GINI_RERANKER_PROVIDER = "local";
    const choice = resolveRerankerChoice(makeConfig());
    expect(choice.name).toBe("local");
    expect(choice.reason).toBe("explicit");
  });

  test("explicit echo / none are honored", () => {
    process.env.GINI_RERANKER_PROVIDER = "echo";
    expect(resolveRerankerChoice(makeConfig()).name).toBe("echo");
    process.env.GINI_RERANKER_PROVIDER = "none";
    expect(resolveRerankerChoice(makeConfig()).name).toBe("none");
  });

  test("GINI_LOCAL_RERANKER_MODEL overrides the default model id", () => {
    process.env.GINI_LOCAL_RERANKER_MODEL = "Xenova/bge-reranker-base";
    const choice = resolveRerankerChoice(makeConfig());
    expect(choice.model).toBe("Xenova/bge-reranker-base");
  });

  test("GINI_RERANKER_TOP_N overrides the default top-N", () => {
    process.env.GINI_RERANKER_TOP_N = "7";
    expect(rerankerTopN()).toBe(7);
    expect(resolveRerankerChoice(makeConfig()).topN).toBe(7);
  });

  test("invalid GINI_RERANKER_TOP_N falls back to the default", () => {
    process.env.GINI_RERANKER_TOP_N = "not-a-number";
    expect(rerankerTopN()).toBe(DEFAULT_RERANKER_TOP_N);
    process.env.GINI_RERANKER_TOP_N = "-3";
    expect(rerankerTopN()).toBe(DEFAULT_RERANKER_TOP_N);
  });
});

describe("getReranker", () => {
  test("returns the local reranker by default", async () => {
    __setTransformersLoaderForTests(async () => makeFakeTransformers(DEFAULT_LOCAL_RERANKER_MODEL));
    const reranker = getReranker(makeConfig());
    expect(reranker.name).toBe("local");
    const scores = await reranker.score("query", ["short", "a much longer candidate text"]);
    expect(scores).toHaveLength(2);
    // Stub scores by length — second candidate is longer, so higher.
    expect(scores[1]!).toBeGreaterThan(scores[0]!);
  });

  test("explicit echo wins even when local is available", async () => {
    process.env.GINI_RERANKER_PROVIDER = "echo";
    const reranker = getReranker(makeConfig());
    expect(reranker.name).toBe("echo");
    const scores = await reranker.score("q", ["a", "b", "c"]);
    expect(scores).toEqual([1, 1 / 2, 1 / 3]);
  });

  test("explicit none returns the pass-through reranker", async () => {
    process.env.GINI_RERANKER_PROVIDER = "none";
    const reranker = getReranker(makeConfig());
    expect(reranker.name).toBe("none");
    const scores = await reranker.score("q", ["a", "b", "c"]);
    // None preserves input order via 1/(1+i).
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
    expect(scores[1]!).toBeGreaterThan(scores[2]!);
  });

  test("local-init failure falls through to none on subsequent calls", async () => {
    // First load throws — emits warning, sets the unavailable flag.
    __setTransformersLoaderForTests(async () => makeFakeTransformers(DEFAULT_LOCAL_RERANKER_MODEL, "throw"));
    const reranker = localReranker(DEFAULT_LOCAL_RERANKER_MODEL);
    const scores = await reranker.score("q", ["a", "b", "c"]);
    // Local impl returns 1/(1+i) on init failure so callers never get an
    // empty / mismatched-length array.
    expect(scores).toHaveLength(3);
    // After failure, getReranker should resolve to the none provider.
    const next = getReranker(makeConfig());
    expect(next.name).toBe("none");
  });
});

describe("echo reranker", () => {
  test("returns 1/(1+index) regardless of content", async () => {
    const reranker = echoReranker();
    const scores = await reranker.score("anything", ["x", "y", "z", "w"]);
    expect(scores[0]!).toBeCloseTo(1, 5);
    expect(scores[1]!).toBeCloseTo(0.5, 5);
    expect(scores[2]!).toBeCloseTo(1 / 3, 5);
    expect(scores[3]!).toBeCloseTo(0.25, 5);
  });

  test("empty candidate list returns empty score list", async () => {
    const reranker = echoReranker();
    expect(await reranker.score("q", [])).toEqual([]);
  });
});

describe("none reranker", () => {
  test("returns 1/(1+index) so input order is preserved if re-sorted", async () => {
    const reranker = noneReranker();
    const scores = await reranker.score("q", ["first", "second", "third"]);
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
    expect(scores[1]!).toBeGreaterThan(scores[2]!);
  });
});

describe("local reranker — model id flows through", () => {
  test("uses GINI_LOCAL_RERANKER_MODEL for the model id reported on the provider", () => {
    process.env.GINI_LOCAL_RERANKER_MODEL = "Xenova/bge-reranker-base";
    __setTransformersLoaderForTests(async () => makeFakeTransformers("Xenova/bge-reranker-base"));
    const reranker = getReranker(makeConfig());
    expect(reranker.model).toBe("Xenova/bge-reranker-base");
  });

  test("explicit localReranker(modelId) call exposes the right model name", async () => {
    __setTransformersLoaderForTests(async () => makeFakeTransformers("Xenova/ms-marco-MiniLM-L-6-v2"));
    const reranker = localReranker("Xenova/ms-marco-MiniLM-L-6-v2");
    expect(reranker.model).toBe("Xenova/ms-marco-MiniLM-L-6-v2");
    const scores = await reranker.score("q", ["one", "two"]);
    expect(scores).toHaveLength(2);
  });
});
