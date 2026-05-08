// Hindsight phase 2 — retain pipeline tests against the echo provider.
//
// We never hit OpenAI from tests; the embedding provider is forced to "echo"
// via env, and structured-output stubs are registered through
// setEchoStructuredResponse so each LLM call returns a deterministic JSON.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { closeAllMemoryDbs, getMemoryDb, listMemoryUnits, ensureDefaultBank, DEFAULT_BANK_ID } from "../../state";
import {
  clearEchoStructuredResponses,
  setEchoStructuredResponse
} from "../../provider";
import { retain } from "./retain";
import { lexicalSimilarity, levenshtein } from "./entities";
import { parseTemporal } from "./temporal";
import { cosineSimilarity, echoEmbed, echoProvider } from "../../embeddings";
import type { RuntimeConfig } from "../../types";

const ROOT = "/tmp/gini-retain-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
});

afterAll(() => {
  closeAllMemoryDbs();
  delete process.env.GINI_EMBEDDING_PROVIDER;
  rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  clearEchoStructuredResponses();
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

describe("temporal parser", () => {
  test("parses ISO date", () => {
    const range = parseTemporal("2025-04-01");
    expect(range).not.toBeNull();
    expect(range!.start.startsWith("2025-04-01")).toBe(true);
  });
  test("parses 'yesterday' relative to reference", () => {
    const ref = new Date("2025-04-10T12:00:00Z");
    const range = parseTemporal("yesterday", ref);
    expect(range!.start.startsWith("2025-04-09")).toBe(true);
  });
  test("parses 'June 9, 2024' with weekday prefix", () => {
    const range = parseTemporal("Saturday, June 9, 2024");
    expect(range!.start.startsWith("2024-06-09")).toBe(true);
  });
  test("parses 'last week' as Monday-Sunday range", () => {
    const ref = new Date("2025-04-10T12:00:00Z"); // Thursday
    const range = parseTemporal("last week", ref);
    // Last week's Monday is 2025-03-31, Sunday 2025-04-06.
    expect(range!.start.startsWith("2025-03-31")).toBe(true);
    expect(range!.end.startsWith("2025-04-06")).toBe(true);
  });
  test("returns null for gibberish", () => {
    expect(parseTemporal("totally not a date")).toBeNull();
  });
});

describe("entity resolution helpers", () => {
  test("levenshtein basic distance", () => {
    expect(levenshtein("cat", "cat")).toBe(0);
    expect(levenshtein("cat", "bat")).toBe(1);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
  test("lexicalSimilarity returns 1 for identical strings", () => {
    expect(lexicalSimilarity("Alice", "Alice")).toBe(1);
  });
  test("lexicalSimilarity is high for near-identical names", () => {
    expect(lexicalSimilarity("Alice Smith", "alice smith")).toBe(1);
    expect(lexicalSimilarity("Alice", "Alyce")).toBeGreaterThan(0.5);
  });
});

describe("openai embedding provider (mocked HTTP)", () => {
  test("posts a batched request to /embeddings and parses by index", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: unknown = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({
        data: [
          { index: 0, embedding: new Array(1536).fill(0.001) },
          { index: 1, embedding: new Array(1536).fill(0.002) }
        ]
      }), { status: 200 });
    }) as typeof fetch;
    try {
      const { openaiProvider } = await import("../../embeddings");
      process.env.OPENAI_API_KEY = "test-key";
      const provider = openaiProvider({
        instance: "openai-test",
        port: 0,
        token: "t",
        provider: { name: "openai", model: "gpt-4o-mini", apiKeyEnv: "OPENAI_API_KEY" },
        workspaceRoot: ROOT,
        stateRoot: ROOT,
        logRoot: ROOT
      });
      const vectors = await provider.embed(["foo", "bar"]);
      expect(vectors.length).toBe(2);
      expect(vectors[0]!.length).toBe(1536);
      const body = capturedBody as { input?: string[]; model?: string };
      expect(body?.model).toBe("text-embedding-3-small");
      expect(body?.input).toEqual(["foo", "bar"]);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe("echo embedding provider", () => {
  test("identical inputs produce identical vectors", () => {
    const a = echoEmbed("hello world");
    const b = echoEmbed("hello world");
    expect(Array.from(a)).toEqual(Array.from(b));
  });
  test("normalizes to unit length", () => {
    const v = echoEmbed("anything");
    let sumSq = 0;
    for (let i = 0; i < v.length; i++) sumSq += v[i]! * v[i]!;
    expect(Math.abs(Math.sqrt(sumSq) - 1)).toBeLessThan(1e-5);
  });
  test("cosine similarity of identical vectors is 1", () => {
    const a = echoEmbed("foo bar");
    const b = echoEmbed("foo bar");
    expect(Math.abs(cosineSimilarity(a, b) - 1)).toBeLessThan(1e-5);
  });
  test("provider.embed returns one vector per input", async () => {
    const provider = echoProvider();
    const vectors = await provider.embed(["a", "b", "c"]);
    expect(vectors).toHaveLength(3);
  });
});

describe("retain pipeline", () => {
  test("happy path: structured stub yields units, entities, and links", async () => {
    const instance = "retain-happy";
    ensureDefaultBank(instance);
    setEchoStructuredResponse("fact-extraction", {
      facts: [
        {
          what: "Alice joined Acme Corp as CTO",
          when: "2025-04-01",
          where: "San Francisco",
          who: "Alice and Acme Corp",
          why: "career move",
          fact_type: "world",
          occurred_start: "2025-04-01T00:00:00Z",
          occurred_end: "2025-04-01T23:59:59Z",
          entities: [
            { text: "Alice", entity_type: "PERSON" },
            { text: "Acme Corp", entity_type: "ORGANIZATION" }
          ]
        },
        {
          what: "Alice gave the keynote at the Acme summit",
          when: "2025-04-02",
          where: "San Francisco",
          who: "Alice",
          why: "celebrate the new role",
          fact_type: "world",
          occurred_start: "2025-04-02T00:00:00Z",
          occurred_end: "2025-04-02T23:59:59Z",
          entities: [
            { text: "Alice", entity_type: "PERSON" },
            { text: "Acme Corp", entity_type: "ORGANIZATION" }
          ],
          causal_relations: [
            { target_fact_index: 0, relation_type: "caused_by", strength: 0.9 }
          ]
        }
      ]
    });
    // No observation stub — the echo provider returns {} which parses to an
    // empty observations[] and the regeneration silently no-ops. Phase 2.4
    // tests below cover the regeneration path explicitly.

    const config = makeConfig(instance);
    const result = await retain(config, { text: "Alice joined Acme Corp as CTO. She gave the keynote.", mentionedAt: "2025-04-02T08:00:00Z" });

    expect(result.units).toHaveLength(2);
    // 2 entities created on first call.
    expect(result.entities.length).toBe(2);
    // Links: entity (a<->b shared 1 entity gives 2), temporal (1 day apart -> 1 directional), semantic (0 — different vectors), causal (1).
    const entityLinks = result.links.filter((l) => l.linkType === "entity");
    expect(entityLinks.length).toBe(2); // bidirectional
    const temporalLinks = result.links.filter((l) => l.linkType === "temporal");
    expect(temporalLinks.length).toBeGreaterThanOrEqual(1);
    expect(temporalLinks[0]!.weight).toBeGreaterThan(0.85); // 1 day, σ=7d -> exp(-1/7) ≈ 0.866
    const causalLinks = result.links.filter((l) => l.linkType === "causal");
    expect(causalLinks.length).toBe(1);
    expect(causalLinks[0]!.causalSubtype).toBe("caused_by");

    // Two facts -> 2 world units. Observations regenerated for both entities.
    const worldUnits = listMemoryUnits(instance, DEFAULT_BANK_ID, { network: "world" });
    expect(worldUnits.length).toBe(2);
  });

  test("entity resolution: same surface twice merges to one canonical", async () => {
    const instance = "retain-merge";
    ensureDefaultBank(instance);
    setEchoStructuredResponse("fact-extraction", {
      facts: [
        {
          what: "Bob joined the company",
          when: "2025-04-01",
          where: "London",
          who: "Bob",
          why: "career",
          fact_type: "world",
          entities: [{ text: "Bob", entity_type: "PERSON" }]
        }
      ]
    });
    const config = makeConfig(instance);
    const first = await retain(config, { text: "Bob joined.", mentionedAt: "2025-04-01T00:00:00Z" });
    expect(first.entities).toHaveLength(1);

    setEchoStructuredResponse("fact-extraction", {
      facts: [
        {
          what: "Bob shipped a release",
          when: "2025-04-02",
          where: "London",
          who: "Bob",
          why: "team work",
          fact_type: "world",
          entities: [{ text: "Bob", entity_type: "PERSON" }]
        }
      ]
    });
    const second = await retain(config, { text: "Bob shipped a release.", mentionedAt: "2025-04-02T00:00:00Z" });
    // Second call should find the existing canonical and not create a new entity.
    expect(second.entities).toHaveLength(0);
  });

  test("entity resolution: near-miss spelling still merges", async () => {
    const instance = "retain-nearmiss";
    ensureDefaultBank(instance);
    setEchoStructuredResponse("fact-extraction", {
      facts: [
        { what: "x", when: "", where: "", who: "Alice Johnson", why: "", fact_type: "world",
          entities: [{ text: "Alice Johnson", entity_type: "PERSON" }] }
      ]
    });
    await retain(makeConfig(instance), { text: "Alice Johnson is here.", mentionedAt: "2025-04-01T00:00:00Z" });

    setEchoStructuredResponse("fact-extraction", {
      facts: [
        { what: "y", when: "", where: "", who: "Alice Johnsen", why: "", fact_type: "world",
          entities: [{ text: "Alice Johnsen", entity_type: "PERSON" }] }
      ]
    });
    const second = await retain(makeConfig(instance), { text: "Alice Johnsen stopped by.", mentionedAt: "2025-04-01T00:00:00Z" });
    // Single-character substitution on a 13-char surface -> Levenshtein 1 ->
    // lexical sim ≈ 0.92, well above the LEXICAL_EXACT_FAST_PATH=0.85.
    expect(second.entities).toHaveLength(0);
  });

  test("temporal links: distant pairs do not link", async () => {
    const instance = "retain-temporal-distant";
    ensureDefaultBank(instance);
    setEchoStructuredResponse("fact-extraction", {
      facts: [
        { what: "fact one", when: "2025-04-01", where: "", who: "", why: "", fact_type: "world",
          occurred_start: "2025-04-01T00:00:00Z", occurred_end: "2025-04-01T23:59:59Z" },
        { what: "fact two", when: "2025-05-15", where: "", who: "", why: "", fact_type: "world",
          occurred_start: "2025-05-15T00:00:00Z", occurred_end: "2025-05-15T23:59:59Z" }
      ]
    });
    const result = await retain(makeConfig(instance), { text: "two distant facts", mentionedAt: "2025-05-15T00:00:00Z" });
    const temporalLinks = result.links.filter((l) => l.linkType === "temporal");
    expect(temporalLinks.length).toBe(0);
  });

  test("semantic links: identical embeddings get linked", async () => {
    const instance = "retain-semantic";
    ensureDefaultBank(instance);
    // Two facts with literally the same `what` text — narrative will be similar
    // enough to clear θ_s = 0.7 with the echo embedding.
    setEchoStructuredResponse("fact-extraction", {
      facts: [
        { what: "team shipped the product launch on april first", when: "2025-04-01",
          where: "office", who: "team", why: "milestone", fact_type: "world" },
        { what: "team shipped the product launch on april first", when: "2025-04-02",
          where: "office", who: "team", why: "milestone", fact_type: "world" }
      ]
    });
    const result = await retain(makeConfig(instance), { text: "near-duplicate facts", mentionedAt: "2025-04-02T00:00:00Z" });
    const semanticLinks = result.links.filter((l) => l.linkType === "semantic");
    expect(semanticLinks.length).toBeGreaterThanOrEqual(2);
  });

  test("observation regeneration: an observation unit is created per touched entity", async () => {
    const instance = "retain-observation";
    ensureDefaultBank(instance);
    setEchoStructuredResponse("fact-extraction", {
      facts: [
        { what: "Eve coded all night", when: "", where: "", who: "Eve", why: "", fact_type: "world",
          entities: [{ text: "Eve", entity_type: "PERSON" }] }
      ]
    });
    setEchoStructuredResponse("observation:", {
      observations: [{ observation: "Eve frequently codes through the night." }]
    });
    await retain(makeConfig(instance), { text: "Eve coded all night.", mentionedAt: "2025-04-02T00:00:00Z" });
    const observations = listMemoryUnits(instance, DEFAULT_BANK_ID, { network: "observation" });
    expect(observations.length).toBe(1);
    expect(observations[0]!.text).toContain("Eve");
  });

  test("audit + trace: retain emits an audit event", async () => {
    const instance = "retain-audit";
    ensureDefaultBank(instance);
    setEchoStructuredResponse("fact-extraction", {
      facts: [
        { what: "x", when: "", where: "", who: "", why: "", fact_type: "world" }
      ]
    });
    await retain(makeConfig(instance), { text: "audited" });
    const { readState } = await import("../../state");
    const state = readState(instance);
    const audit = state.audit.find((event) => event.action === "memory.retain");
    expect(audit).toBeDefined();
    expect(audit!.evidence).toMatchObject({ units: 1 });
  });
});
