// Embedding-provider selection-logic + local-provider tests.
//
// These tests must never pull a real model from the hub: we stub the
// dynamic import via __setTransformersLoaderForTests so the local-provider
// code path runs without the network or the native binding.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  __setTransformersLoaderForTests,
  DEFAULT_LOCAL_EMBEDDING_DIM,
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  echoProvider,
  getEmbeddingProvider,
  localProvider,
  resolveEmbeddingChoice
} from "./embeddings";
import type { RuntimeConfig } from "./types";

const ROOT = "/tmp/gini-embeddings-test";

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
  delete process.env.GINI_EMBEDDING_PROVIDER;
  delete process.env.GINI_LOCAL_EMBEDDING_MODEL;
  delete process.env.OPENAI_API_KEY;
  __setTransformersLoaderForTests(null);
});

function makeConfig(): RuntimeConfig {
  return {
    instance: "embed-test",
    port: 0,
    token: "t",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

// Builds a fake @huggingface/transformers module so getEmbeddingProvider's
// local path executes end-to-end without the real native binding. Returns a
// deterministic 384-d unit vector so tests can assert dim/sanity.
function makeFakeTransformers(modelId: string) {
  const env: Record<string, unknown> = { cacheDir: "" };
  return {
    pipeline: async (_task: string, model: string) => {
      expect(model).toBe(modelId);
      return async (text: string | string[], _opts: { pooling: "mean"; normalize: boolean }) => {
        const single = Array.isArray(text) ? text[0]! : text;
        // Cheap deterministic hash → fill 384 floats. Doesn't matter what
        // they are; we only assert shape.
        const data = new Float32Array(DEFAULT_LOCAL_EMBEDDING_DIM);
        let hash = 0;
        for (let i = 0; i < single.length; i++) hash = (hash * 31 + single.charCodeAt(i)) & 0xffffffff;
        for (let i = 0; i < data.length; i++) data[i] = ((hash + i) % 1000) / 1000;
        return { data, dims: [1, DEFAULT_LOCAL_EMBEDDING_DIM] };
      };
    },
    env
  };
}

describe("resolveEmbeddingChoice", () => {
  test("default (no env) is local with the default model", () => {
    const config = makeConfig();
    const choice = resolveEmbeddingChoice(config);
    expect(choice.name).toBe("local");
    expect(choice.model).toBe(DEFAULT_LOCAL_EMBEDDING_MODEL);
    expect(choice.reason).toBe("default");
  });

  test("explicit GINI_EMBEDDING_PROVIDER=local pins local", () => {
    process.env.GINI_EMBEDDING_PROVIDER = "local";
    const choice = resolveEmbeddingChoice(makeConfig());
    expect(choice.name).toBe("local");
    expect(choice.reason).toBe("explicit");
  });

  test("GINI_LOCAL_EMBEDDING_MODEL overrides the default model id", () => {
    process.env.GINI_LOCAL_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
    const choice = resolveEmbeddingChoice(makeConfig());
    expect(choice.model).toBe("Xenova/bge-small-en-v1.5");
  });

  test("explicit echo / openai are honored", () => {
    process.env.GINI_EMBEDDING_PROVIDER = "echo";
    expect(resolveEmbeddingChoice(makeConfig()).name).toBe("echo");
    delete process.env.GINI_EMBEDDING_PROVIDER;
    process.env.GINI_EMBEDDING_PROVIDER = "openai";
    expect(resolveEmbeddingChoice(makeConfig()).name).toBe("openai");
  });
});

describe("getEmbeddingProvider", () => {
  test("returns the local provider by default", async () => {
    __setTransformersLoaderForTests(async () => makeFakeTransformers(DEFAULT_LOCAL_EMBEDDING_MODEL));
    const provider = getEmbeddingProvider(makeConfig());
    expect(provider.name).toBe("local");
    const vectors = await provider.embed(["alice", "bob"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]!.length).toBe(DEFAULT_LOCAL_EMBEDDING_DIM);
  });

  test("explicit echo wins even when local is available", () => {
    process.env.GINI_EMBEDDING_PROVIDER = "echo";
    const provider = getEmbeddingProvider(makeConfig());
    expect(provider.name).toBe("echo");
  });

  test("explicit openai wins and produces an openai-shaped provider", () => {
    process.env.GINI_EMBEDDING_PROVIDER = "openai";
    const provider = getEmbeddingProvider(makeConfig());
    expect(provider.name).toBe("openai");
    expect(provider.model).toBe("text-embedding-3-small");
  });
});

describe("local provider — model id flows through", () => {
  test("uses GINI_LOCAL_EMBEDDING_MODEL for the model id reported on the provider", () => {
    process.env.GINI_LOCAL_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
    __setTransformersLoaderForTests(async () => makeFakeTransformers("Xenova/bge-small-en-v1.5"));
    const provider = getEmbeddingProvider(makeConfig());
    expect(provider.model).toBe("Xenova/bge-small-en-v1.5");
  });

  test("explicit localProvider(modelId) call exposes the right model name", async () => {
    __setTransformersLoaderForTests(async () => makeFakeTransformers("Xenova/all-MiniLM-L6-v2"));
    const provider = localProvider("Xenova/all-MiniLM-L6-v2");
    expect(provider.model).toBe("Xenova/all-MiniLM-L6-v2");
    const [vector] = await provider.embed(["hello"]);
    expect(vector!.length).toBe(DEFAULT_LOCAL_EMBEDDING_DIM);
  });
});

describe("echo provider sanity", () => {
  test("returns one vector per input", async () => {
    const provider = echoProvider();
    const vectors = await provider.embed(["a", "b", "c"]);
    expect(vectors).toHaveLength(3);
  });
});
