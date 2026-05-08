// Hindsight phase 3 — recall pipeline tests.
//
// We seed the SQLite memory store with hand-crafted units (bypassing retain
// where convenient) so each channel can be exercised in isolation, then
// exercise full RRF fusion + token budget.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  closeAllMemoryDbs,
  ensureDefaultBank,
  insertEntity,
  insertLink,
  insertMemoryUnit,
  linkUnitToEntity,
  DEFAULT_BANK_ID
} from "../../state";
import { recall } from "./recall";
import { echoEmbed } from "../../embeddings";
import type { RuntimeConfig } from "../../types";

const ROOT = "/tmp/gini-recall-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
  // Channel-level recall tests assert ordering against pure RRF. Pin the
  // reranker to `none` so the cross-encoder pass doesn't reshuffle the head
  // out from under those assertions. The reranker-specific behavior tests
  // live in src/reranker.test.ts and a dedicated describe block below.
  process.env.GINI_RERANKER_PROVIDER = "none";
});

afterAll(() => {
  closeAllMemoryDbs();
  delete process.env.GINI_EMBEDDING_PROVIDER;
  delete process.env.GINI_RERANKER_PROVIDER;
  rmSync(ROOT, { recursive: true, force: true });
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

describe("recall — semantic channel", () => {
  test("returns the unit closest to the query embedding first", async () => {
    const instance = "recall-semantic";
    ensureDefaultBank(instance);
    const target = insertMemoryUnit(instance, {
      text: "alpha bravo charlie delta echo",
      embedding: echoEmbed("alpha bravo charlie delta echo"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    insertMemoryUnit(instance, {
      text: "completely unrelated topic about gardens and hedges",
      embedding: echoEmbed("completely unrelated topic about gardens and hedges"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const result = await recall(makeConfig(instance), { query: "alpha bravo charlie delta echo" });
    expect(result.units.length).toBeGreaterThan(0);
    expect(result.units[0]!.unit.id).toBe(target.id);
    expect(result.units[0]!.channels).toContain("semantic");
  });
});

describe("recall — bm25 channel", () => {
  test("surfaces a lexical match when semantic similarity is weaker", async () => {
    const instance = "recall-bm25";
    ensureDefaultBank(instance);
    // Distinct lexical word that exists in only one unit.
    const target = insertMemoryUnit(instance, {
      text: "the quokka is a small marsupial",
      embedding: echoEmbed("the quokka is a small marsupial"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    insertMemoryUnit(instance, {
      text: "office supplies inventory list",
      embedding: echoEmbed("office supplies inventory list"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const result = await recall(makeConfig(instance), { query: "quokka" });
    const hit = result.units.find((entry) => entry.unit.id === target.id);
    expect(hit).toBeDefined();
    expect(hit!.channels).toContain("bm25");
  });
});

describe("recall — graph channel", () => {
  test("surfaces an indirectly connected unit via entity link", async () => {
    const instance = "recall-graph";
    ensureDefaultBank(instance);
    const seed = insertMemoryUnit(instance, {
      text: "Alice joined the company",
      embedding: echoEmbed("Alice joined the company"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const linked = insertMemoryUnit(instance, {
      text: "Alice gave a talk at the all-hands",
      embedding: echoEmbed("xyzzy plover something completely different"), // make semantic miss
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    // override embedding so the semantic channel won't surface it directly.
    const entity = insertEntity(instance, { canonicalName: "Alice", entityType: "PERSON" });
    linkUnitToEntity(instance, seed.id, entity.id, "Alice");
    linkUnitToEntity(instance, linked.id, entity.id, "Alice");
    insertLink(instance, { fromUnit: seed.id, toUnit: linked.id, linkType: "entity", weight: 1.0, entityId: entity.id });
    insertLink(instance, { fromUnit: linked.id, toUnit: seed.id, linkType: "entity", weight: 1.0, entityId: entity.id });

    const result = await recall(makeConfig(instance), { query: "Alice joined the company" });
    const hit = result.units.find((entry) => entry.unit.id === linked.id);
    expect(hit).toBeDefined();
    expect(hit!.channels).toContain("graph");
  });
});

describe("recall — temporal channel", () => {
  test("matches units within the query date range", async () => {
    const instance = "recall-temporal";
    ensureDefaultBank(instance);
    insertMemoryUnit(instance, {
      text: "happened in april",
      embedding: echoEmbed("happened in april"),
      embeddingModel: "echo-embed-v0",
      network: "world",
      occurredStart: "2025-04-10T00:00:00Z",
      occurredEnd: "2025-04-10T23:59:59Z"
    });
    insertMemoryUnit(instance, {
      text: "happened way later",
      embedding: echoEmbed("happened way later"),
      embeddingModel: "echo-embed-v0",
      network: "world",
      occurredStart: "2025-09-01T00:00:00Z",
      occurredEnd: "2025-09-01T23:59:59Z"
    });
    const result = await recall(makeConfig(instance), {
      query: "what happened on 2025-04-10",
      reference: "2025-12-01T00:00:00Z"
    });
    const hits = result.units.filter((entry) => entry.channels.includes("temporal"));
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.unit.text).toContain("april");
  });

  test("returns nothing temporal when the query has no temporal expression", async () => {
    const instance = "recall-temporal-empty";
    ensureDefaultBank(instance);
    insertMemoryUnit(instance, {
      text: "neutral fact",
      embedding: echoEmbed("neutral fact"),
      embeddingModel: "echo-embed-v0",
      network: "world",
      occurredStart: "2025-04-10T00:00:00Z",
      occurredEnd: "2025-04-10T23:59:59Z"
    });
    const result = await recall(makeConfig(instance), { query: "tell me everything you know" });
    const temporal = result.units.filter((entry) => entry.channels.includes("temporal"));
    expect(temporal.length).toBe(0);
  });
});

describe("recall — cross-model embedding filter", () => {
  test("semantic channel skips units embedded with a different model than the active provider", async () => {
    const instance = "recall-cross-model";
    ensureDefaultBank(instance);
    // Active provider is echo (echo-embed-v0). Insert a unit with a stale
    // model id but otherwise-identical text — the semantic channel should
    // ignore it. The bm25 channel still matches lexically, so the unit may
    // appear via that path; we only assert it doesn't surface via semantic.
    const stale = insertMemoryUnit(instance, {
      text: "lemur lemur lemur",
      embedding: echoEmbed("lemur lemur lemur"),
      embeddingModel: "text-embedding-3-small",
      network: "world"
    });
    const fresh = insertMemoryUnit(instance, {
      text: "different content entirely",
      embedding: echoEmbed("different content entirely"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const result = await recall(makeConfig(instance), { query: "lemur lemur lemur" });
    const staleHit = result.units.find((entry) => entry.unit.id === stale.id);
    if (staleHit) {
      // If it shows up at all (via bm25), it must NOT be on the semantic channel.
      expect(staleHit.channels).not.toContain("semantic");
    }
    // Sanity: the same-model unit is reachable via semantic.
    const freshHit = result.units.find((entry) => entry.unit.id === fresh.id);
    if (freshHit) expect(freshHit.channels).toContain("semantic");
  });
});

describe("recall — RRF fusion + token budget", () => {
  test("a unit appearing in multiple channels ranks higher than one in a single channel", async () => {
    const instance = "recall-fusion";
    ensureDefaultBank(instance);
    // Multi-channel hit: lexical match on "elephant" AND embedding close to query.
    const multi = insertMemoryUnit(instance, {
      text: "elephant elephant elephant matters here",
      embedding: echoEmbed("elephant elephant elephant matters here"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    // Single-channel hit: only the embedding has overlap.
    const single = insertMemoryUnit(instance, {
      text: "matters here truly",
      embedding: echoEmbed("matters here truly"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const result = await recall(makeConfig(instance), { query: "elephant matters here" });
    const multiPos = result.units.findIndex((entry) => entry.unit.id === multi.id);
    const singlePos = result.units.findIndex((entry) => entry.unit.id === single.id);
    expect(multiPos).toBeGreaterThanOrEqual(0);
    expect(singlePos).toBeGreaterThanOrEqual(0);
    expect(multiPos).toBeLessThan(singlePos);
  });

  test("token budget caps the packed unit list", async () => {
    const instance = "recall-budget";
    ensureDefaultBank(instance);
    // Insert ten 200-character units; budget = 100 tokens (~400 chars) packs ~2.
    const text = "padding ".repeat(25); // ~200 chars
    for (let i = 0; i < 10; i++) {
      insertMemoryUnit(instance, {
        text: `${text} unique-token-${i}`,
        embedding: echoEmbed(`${text} unique-token-${i}`),
        embeddingModel: "echo-embed-v0",
        network: "world"
      });
    }
    const result = await recall(makeConfig(instance), { query: "padding", tokenBudget: 100 });
    expect(result.totalTokens).toBeLessThanOrEqual(100);
    expect(result.units.length).toBeLessThan(10);
  });
});

// Cross-encoder reranking behavior, exercised end-to-end via recall(). The
// reranker provider is set per-test inside the block; we restore the
// suite-wide `none` pin afterwards so other describe blocks stay stable.
describe("recall — cross-encoder reranking", () => {
  test("with reranker=none, recall ordering matches pure RRF", async () => {
    process.env.GINI_RERANKER_PROVIDER = "none";
    const instance = "recall-rerank-none";
    ensureDefaultBank(instance);
    insertMemoryUnit(instance, {
      text: "elephant elephant elephant matters here",
      embedding: echoEmbed("elephant elephant elephant matters here"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    insertMemoryUnit(instance, {
      text: "matters here truly",
      embedding: echoEmbed("matters here truly"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const result = await recall(makeConfig(instance), { query: "elephant matters here" });
    // Multi-channel hit (semantic+bm25) should rank ahead of the
    // single-channel hit. None reranker is a strict pass-through.
    expect(result.units[0]!.unit.text).toContain("elephant");
    // RRF scores are small (1/(k+rank+1)) — none reranker keeps them.
    expect(result.units[0]!.score).toBeLessThan(1);
  });

  test("with reranker=echo, head candidates carry echo scores 1/(1+i)", async () => {
    process.env.GINI_RERANKER_PROVIDER = "echo";
    const instance = "recall-rerank-echo";
    ensureDefaultBank(instance);
    insertMemoryUnit(instance, {
      text: "first thing about widgets",
      embedding: echoEmbed("first thing about widgets"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    insertMemoryUnit(instance, {
      text: "second thing about widgets",
      embedding: echoEmbed("second thing about widgets"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    insertMemoryUnit(instance, {
      text: "third thing about widgets",
      embedding: echoEmbed("third thing about widgets"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const result = await recall(makeConfig(instance), { query: "thing about widgets" });
    expect(result.units.length).toBeGreaterThan(0);
    // Echo reranker assigns 1/(1+i) by input position, then re-sorts by
    // that score. The top unit must score 1; the second 0.5; etc.
    expect(result.units[0]!.score).toBeCloseTo(1, 5);
    if (result.units.length > 1) expect(result.units[1]!.score).toBeCloseTo(0.5, 5);
    if (result.units.length > 2) expect(result.units[2]!.score).toBeCloseTo(1 / 3, 5);
    // Restore suite-wide pin for the rest of the file.
    process.env.GINI_RERANKER_PROVIDER = "none";
  });
});
