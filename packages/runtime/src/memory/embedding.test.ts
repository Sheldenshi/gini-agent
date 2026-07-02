// Embedding-domain tests: reembed walks units, replaces vectors, audits.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  closeAllMemoryDbs,
  DEFAULT_BANK_ID,
  ensureDefaultBank,
  insertMemoryUnit,
  listMemoryUnits,
  readState
} from "../state";
import { embeddingStatus, reembedAllBanks, reembedBank } from "./embedding";
import { ensureAgentBank } from "../state";
import type { RuntimeConfig } from "../types";

const ROOT = "/tmp/gini-embed-domain-test";

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

beforeEach(() => {
  closeAllMemoryDbs();
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

describe("embeddingStatus", () => {
  test("reports the active provider + per-bank model breakdown", () => {
    const instance = "embed-status";
    ensureDefaultBank(instance);
    insertMemoryUnit(instance, {
      bankId: DEFAULT_BANK_ID,
      text: "alice works at google",
      embedding: new Float32Array(32).fill(0.1),
      embeddingModel: "echo-embed-v0",
      network: "world"
    });
    const status = embeddingStatus(makeConfig(instance));
    expect(status.provider.name).toBe("echo");
    expect(status.provider.model).toBe("echo-embed-v0");
    expect(status.byBank.length).toBeGreaterThan(0);
    const row = status.byBank.find((r) => r.bankId === DEFAULT_BANK_ID && r.embeddingModel === "echo-embed-v0");
    expect(row?.count).toBe(1);
    expect(status.modelMismatch).toBe(false);
  });

  test("flags model mismatch when a unit was embedded with a different model", () => {
    const instance = "embed-status-mismatch";
    ensureDefaultBank(instance);
    insertMemoryUnit(instance, {
      bankId: DEFAULT_BANK_ID,
      text: "old vector",
      embedding: new Float32Array(1536).fill(0.001),
      embeddingModel: "text-embedding-3-small",
      network: "world"
    });
    const status = embeddingStatus(makeConfig(instance));
    expect(status.provider.name).toBe("echo");
    expect(status.modelMismatch).toBe(true);
  });
});

describe("reembedBank", () => {
  test("walks active units, replaces their vectors with the active provider's model, and emits an audit event", async () => {
    const instance = "embed-reembed";
    const config = makeConfig(instance);
    ensureDefaultBank(instance);
    // Seed two units, one with a stale model, one with no embedding at all.
    insertMemoryUnit(instance, {
      bankId: DEFAULT_BANK_ID,
      text: "alice works at google",
      embedding: new Float32Array(1536).fill(0.001),
      embeddingModel: "text-embedding-3-small",
      network: "world"
    });
    insertMemoryUnit(instance, {
      bankId: DEFAULT_BANK_ID,
      text: "bob works at apple",
      embedding: null,
      embeddingModel: null,
      network: "world"
    });

    const report = await reembedBank(config, {});
    expect(report.totalUnits).toBe(2);
    expect(report.migrated).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.provider.name).toBe("echo");

    const units = listMemoryUnits(instance, DEFAULT_BANK_ID);
    for (const unit of units) {
      expect(unit.embeddingModel).toBe("echo-embed-v0");
      expect(unit.embeddingDim).toBe(32);
      expect(unit.embedding).not.toBeNull();
    }

    // Audit event landed.
    const state = readState(instance);
    const audit = state.audit.find((entry) => entry.action === "embedding.reembed");
    expect(audit).toBeTruthy();
    expect((audit?.evidence as { migrated: number }).migrated).toBe(2);
  });

  test("dry run reports counts without touching the rows", async () => {
    const instance = "embed-reembed-dry";
    const config = makeConfig(instance);
    ensureDefaultBank(instance);
    insertMemoryUnit(instance, {
      bankId: DEFAULT_BANK_ID,
      text: "carol works at amazon",
      embedding: new Float32Array(1536).fill(0.001),
      embeddingModel: "text-embedding-3-small",
      network: "world"
    });
    const report = await reembedBank(config, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.migrated).toBe(1);
    const [unit] = listMemoryUnits(instance, DEFAULT_BANK_ID);
    // Untouched: vector, dim, model are exactly what we inserted.
    expect(unit?.embeddingModel).toBe("text-embedding-3-small");
    expect(unit?.embeddingDim).toBe(1536);

    const state = readState(instance);
    expect(state.audit.find((entry) => entry.action === "embedding.reembed.dry-run")).toBeTruthy();
  });
});

describe("reembedAllBanks", () => {
  test("walks every bank — the post-openclaw-migration workflow that single-bank reembed misses", async () => {
    const instance = "embed-reembed-all-banks";
    const config = makeConfig(instance);
    ensureDefaultBank(instance);
    // Two per-agent banks plus the default — simulates an openclaw
    // migration that routed 'main' + 'work' agents into dedicated
    // banks alongside the seeded default.
    const mainBank = ensureAgentBank(instance, "agent_main");
    const workBank = ensureAgentBank(instance, "agent_work");
    insertMemoryUnit(instance, {
      bankId: DEFAULT_BANK_ID,
      agentId: null,
      text: "orphan unit",
      network: "world"
    });
    insertMemoryUnit(instance, {
      bankId: mainBank.id,
      agentId: "agent_main",
      text: "main unit",
      network: "world"
    });
    insertMemoryUnit(instance, {
      bankId: workBank.id,
      agentId: "agent_work",
      text: "work unit",
      network: "world"
    });
    const reports = await reembedAllBanks(config, {});
    // One report per bank, all using the active provider (echo here).
    const bankIds = reports.map((r) => r.bankId).sort();
    expect(bankIds).toEqual([DEFAULT_BANK_ID, mainBank.id, workBank.id].sort());
    for (const report of reports) {
      expect(report.totalUnits).toBe(1);
      expect(report.migrated).toBe(1);
      expect(report.failed).toBe(0);
    }
    // Every unit ends up with a populated embedding now.
    for (const bankId of [DEFAULT_BANK_ID, mainBank.id, workBank.id]) {
      const units = listMemoryUnits(instance, bankId);
      expect(units).toHaveLength(1);
      expect(units[0]!.embedding).not.toBeNull();
      expect(units[0]!.embeddingModel).not.toBeNull();
    }
  });
});
