// Embedding-provider selection-logic + local-provider tests.
//
// These tests must never pull a real model from the hub: we stub the
// dynamic import via __setTransformersLoaderForTests so the local-provider
// code path runs without the network or the native binding.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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

// Snapshot the env vars these tests mutate and restore prior values after each,
// so a developer's/CI's ambient provider keys aren't clobbered by an
// unconditional delete (these run in the same process as other suites).
const SNAPSHOT_ENV = [
  "GINI_EMBEDDING_PROVIDER",
  "GINI_LOCAL_EMBEDDING_MODEL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY"
];
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = {};
  for (const key of SNAPSHOT_ENV) envSnapshot[key] = process.env[key];
});

afterEach(() => {
  for (const key of SNAPSHOT_ENV) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
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

describe("embedOpenAIBatch endpoint routing", () => {
  // Capture each fetch so we can assert the embeddings request never borrows a
  // non-OpenAI chat provider's host or key.
  function stubFetch(): { calls: Array<{ url: string; auth: string }>; restore: () => void } {
    const calls: Array<{ url: string; auth: string }> = [];
    const prev = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), auth: headers.authorization ?? "" });
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = prev; } };
  }

  function withProvider(provider: RuntimeConfig["provider"]): RuntimeConfig {
    return { ...makeConfig(), provider };
  }

  test("anthropic active → embeddings hit api.openai.com with OPENAI_API_KEY, never the Anthropic host or key", async () => {
    process.env.GINI_EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-openai-real";
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    const stub = stubFetch();
    try {
      const provider = getEmbeddingProvider(
        withProvider({ name: "anthropic", model: "claude-opus-4-8", baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY" })
      );
      await provider.embed(["hello"]);
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]!.url).toBe("https://api.openai.com/v1/embeddings");
      expect(stub.calls[0]!.auth).toBe("Bearer sk-openai-real");
      expect(stub.calls[0]!.url).not.toContain("anthropic");
      expect(stub.calls[0]!.auth).not.toContain("sk-ant-secret");
    } finally {
      stub.restore();
    }
  });

  test("openai-compatible provider (openrouter) reuses its configured baseUrl + key for embeddings", async () => {
    process.env.GINI_EMBEDDING_PROVIDER = "openai";
    process.env.OPENROUTER_API_KEY = "sk-or-key";
    const stub = stubFetch();
    try {
      const provider = getEmbeddingProvider(
        withProvider({ name: "openrouter", model: "x", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" })
      );
      await provider.embed(["hi"]);
      expect(stub.calls[0]!.url).toBe("https://openrouter.ai/api/v1/embeddings");
      expect(stub.calls[0]!.auth).toBe("Bearer sk-or-key");
    } finally {
      stub.restore();
    }
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
