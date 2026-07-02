// Hindsight phase 4 — reflect + reinforcement tests.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  bankIdForAgent,
  closeAllMemoryDbs,
  ensureAgentBank,
  ensureDefaultBank,
  insertMemoryUnit,
  listMemoryUnits,
  updateBank,
  DEFAULT_BANK_ID
} from "../state";
import {
  clearEchoStructuredResponses,
  setEchoStructuredResponse
} from "../provider";
import { reflect, verbalizeProfile, buildReflectSystemMessage } from "./reflect";
import { applyVerdict } from "./reinforce";
import { retain } from "./retain";
import { echoEmbed } from "../embeddings";
import type { RuntimeConfig } from "../types";

const ROOT = "/tmp/gini-reflect-test";
const TEST_AGENT = "agent_test";
const TEST_BANK = bankIdForAgent(TEST_AGENT);

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  process.env.GINI_EMBEDDING_PROVIDER = "echo";
  process.env.GINI_RERANKER_PROVIDER = "none";
});

afterAll(() => {
  closeAllMemoryDbs();
  delete process.env.GINI_EMBEDDING_PROVIDER;
  delete process.env.GINI_RERANKER_PROVIDER;
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

describe("verbalizeProfile bands", () => {
  test("low skepticism is trusting", () => {
    const text = verbalizeProfile({
      id: "x", agentId: null, name: "x", agentName: null, background: null,
      skepticism: 1, literalism: 3, empathy: 3, biasStrength: 0.5,
      createdAt: "", updatedAt: ""
    });
    expect(text).toContain("trusting");
  });
  test("high empathy is highly empathetic", () => {
    const text = verbalizeProfile({
      id: "x", agentId: null, name: "x", agentName: null, background: null,
      skepticism: 3, literalism: 3, empathy: 5, biasStrength: 0.5,
      createdAt: "", updatedAt: ""
    });
    expect(text).toContain("empathetic");
  });
  test("max literalism is highly literal", () => {
    const text = verbalizeProfile({
      id: "x", agentId: null, name: "x", agentName: null, background: null,
      skepticism: 3, literalism: 5, empathy: 3, biasStrength: 0.5,
      createdAt: "", updatedAt: ""
    });
    expect(text).toContain("literally");
  });
});

describe("buildReflectSystemMessage bias modulation", () => {
  test("bias near 0 produces a neutral message without verbalized profile", () => {
    const message = buildReflectSystemMessage({
      id: "x", agentId: null, name: "x", agentName: null, background: null,
      skepticism: 1, literalism: 1, empathy: 1, biasStrength: 0,
      createdAt: "", updatedAt: ""
    }, []);
    expect(message).toContain("neutral, factual");
    expect(message).not.toContain("trusting");
  });
  test("bias near 1 marks personality as very strong", () => {
    const message = buildReflectSystemMessage({
      id: "x", agentId: null, name: "x", agentName: null, background: null,
      skepticism: 5, literalism: 5, empathy: 5, biasStrength: 1,
      createdAt: "", updatedAt: ""
    }, []);
    expect(message).toContain("very strong");
    expect(message).toContain("skeptical");
  });
});

describe("reflect pipeline", () => {
  test("stores opinions returned by the LLM as opinion-network units", async () => {
    const instance = "reflect-happy";
    ensureDefaultBank(instance);
    ensureAgentBank(instance, TEST_AGENT);
    // Seed at least one fact so recall returns something (not strictly required).
    insertMemoryUnit(instance, {
      bankId: TEST_BANK,
      agentId: TEST_AGENT,
      text: "Alice ships fast",
      embedding: echoEmbed("Alice ships fast"),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    setEchoStructuredResponse("opinion-formation", {
      opinions: [
        { opinion: "I think Alice is reliable.", confidence: 0.8, reasoning: "based on shipping cadence" },
        { opinion: "I believe predictability matters more than speed.", confidence: 0.6, reasoning: "preference" }
      ]
    });
    const result = await reflect(makeConfig(instance), { agentId: TEST_AGENT, query: "What do you think of Alice?" });
    expect(result.opinions.length).toBe(2);
    expect(result.opinions[0]!.network).toBe("opinion");
    expect(result.opinions[0]!.confidence).toBe(0.8);
    const opinionUnits = listMemoryUnits(instance, TEST_BANK, { network: "opinion" });
    expect(opinionUnits.length).toBeGreaterThanOrEqual(2);
  });
});

describe("reinforcement applyVerdict math", () => {
  test("reinforce adds alpha-step", () => { expect(applyVerdict(0.5, "reinforce")).toBeCloseTo(0.6, 5); });
  test("weaken subtracts alpha-step", () => { expect(applyVerdict(0.5, "weaken")).toBeCloseTo(0.4, 5); });
  test("contradict flips around 0.5", () => { expect(applyVerdict(0.9, "contradict")).toBeCloseTo(0.1, 5); });
  test("neutral keeps confidence", () => { expect(applyVerdict(0.7, "neutral")).toBe(0.7); });
  test("clamps to [0,1]", () => {
    expect(applyVerdict(0.95, "reinforce")).toBe(1);
    expect(applyVerdict(0.05, "weaken")).toBe(0);
  });
});

describe("end-to-end: retain triggers opinion reinforcement", () => {
  test("a stored opinion's confidence shifts when a related fact is retained", async () => {
    const instance = "reflect-reinforce-e2e";
    ensureDefaultBank(instance);
    ensureAgentBank(instance, TEST_AGENT);
    // Seed the canonical Alice entity and link an opinion to it. This is the
    // shape the agent gets in production: an earlier reflect formed an opinion
    // about Alice and we already linked it via the bank's entity store.
    const { insertEntity, linkUnitToEntity } = await import("../state");
    const aliceEntity = insertEntity(instance, { bankId: TEST_BANK, canonicalName: "Alice", entityType: "PERSON" });
    const opinion = insertMemoryUnit(instance, {
      bankId: TEST_BANK,
      agentId: TEST_AGENT,
      text: "I think Alice is reliable.",
      embedding: echoEmbed("I think Alice is reliable."),
      embeddingModel: "echo-embed-v0",
      network: "opinion",
      confidence: 0.5
    });
    linkUnitToEntity(instance, opinion.id, aliceEntity.id, "Alice");
    // Stub retain to extract a fact mentioning Alice.
    setEchoStructuredResponse("fact-extraction", {
      facts: [
        { what: "Alice shipped on time again", when: "2025-04-10", where: "office",
          who: "Alice", why: "consistency", fact_type: "world",
          entities: [{ text: "Alice", entity_type: "PERSON" }] }
      ]
    });
    // Stub the assessment LLM call: reinforce.
    setEchoStructuredResponse(`assess:${opinion.id}`, { verdict: "reinforce", reasoning: "consistent shipping" });

    await retain(makeConfig(instance), { agentId: TEST_AGENT, text: "Alice shipped on time again.", mentionedAt: "2025-04-10T00:00:00Z" });

    const opinions = listMemoryUnits(instance, TEST_BANK, { network: "opinion" });
    const refreshed = opinions.find((unit) => unit.id === opinion.id);
    expect(refreshed!.confidence).toBeCloseTo(0.6, 5);
  });
});

describe("bank profile CRUD", () => {
  test("updateBank patches columns and persists across reads", () => {
    const instance = "bank-crud";
    ensureDefaultBank(instance);
    const updated = updateBank(instance, DEFAULT_BANK_ID, { skepticism: 5, biasStrength: 0.9, name: "Cynical Gini" });
    expect(updated!.skepticism).toBe(5);
    expect(updated!.biasStrength).toBe(0.9);
    expect(updated!.name).toBe("Cynical Gini");
  });
  test("updateBank clamps slider values into the legal band", () => {
    const instance = "bank-clamp";
    ensureDefaultBank(instance);
    const updated = updateBank(instance, DEFAULT_BANK_ID, { skepticism: 99, biasStrength: 5 });
    expect(updated!.skepticism).toBe(5);
    expect(updated!.biasStrength).toBe(1);
  });
});
