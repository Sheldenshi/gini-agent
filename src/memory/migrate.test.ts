// Hindsight phase 6 — migration tests.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  closeAllMemoryDbs,
  countMemoryUnits,
  ensureDefaultBank,
  listMemoryUnits,
  mutateState,
  readState,
  DEFAULT_BANK_ID
} from "../state";
import { createMemory } from "../state";
import { migrateLegacyMemories, legacyMigrationStatus } from "./migrate";
import type { RuntimeConfig } from "../types";

const ROOT = "/tmp/gini-migrate-test";

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

async function seedLegacy(instance: string, count: number, network: "world" | "experience" = "world") {
  await mutateState(instance, (state) => {
    for (let i = 0; i < count; i++) {
      // Mix in an experience-shaped one to exercise the network classifier.
      const content = network === "experience"
        ? `I tried thing ${i} and it worked.`
        : `Fact ${i} about the project.`;
      createMemory(state, {
        content,
        scope: "project",
        sourceTaskId: `task_${i}`,
        confidence: 0.7,
        status: "active",
        sensitivity: "normal",
        provenance: `seed test ${i}`
      });
    }
  });
}

describe("phase 6 migration", () => {
  test("migrates active legacy records into the SQLite store and marks them migrated", async () => {
    const instance = "phase6-migrate-basic";
    ensureDefaultBank(instance);
    await seedLegacy(instance, 3);
    expect(countMemoryUnits(instance)).toBe(0);

    const report = await migrateLegacyMemories(makeConfig(instance));
    expect(report.total).toBe(3);
    expect(report.migrated).toBe(3);
    expect(report.failed).toBe(0);
    expect(countMemoryUnits(instance)).toBe(3);

    const legacy = readState(instance).memories;
    expect(legacy.every((entry) => Boolean(entry.metadata?.migratedToUnitId))).toBe(true);
  });

  test("re-running the migration is idempotent", async () => {
    const instance = "phase6-migrate-idem";
    ensureDefaultBank(instance);
    await seedLegacy(instance, 2);
    await migrateLegacyMemories(makeConfig(instance));
    const before = countMemoryUnits(instance);
    const report = await migrateLegacyMemories(makeConfig(instance));
    expect(report.migrated).toBe(0);
    expect(report.skipped).toBe(2);
    expect(countMemoryUnits(instance)).toBe(before);
  });

  test("classifies first-person content as experience", async () => {
    const instance = "phase6-migrate-classify";
    ensureDefaultBank(instance);
    await seedLegacy(instance, 2, "experience");
    await migrateLegacyMemories(makeConfig(instance));
    const experiences = listMemoryUnits(instance, DEFAULT_BANK_ID, { network: "experience" });
    expect(experiences.length).toBe(2);
  });

  test("legacyMigrationStatus reports pending vs migrated", async () => {
    const instance = "phase6-migrate-status";
    ensureDefaultBank(instance);
    await seedLegacy(instance, 4);
    let status = legacyMigrationStatus(readState(instance).memories);
    expect(status.pending).toBe(4);
    expect(status.migrated).toBe(0);
    await migrateLegacyMemories(makeConfig(instance));
    status = legacyMigrationStatus(readState(instance).memories);
    expect(status.pending).toBe(0);
    expect(status.migrated).toBe(4);
    expect(status.fullyMigrated).toBe(true);
  });

  test("proposed and rejected records are not migrated", async () => {
    const instance = "phase6-migrate-skip-status";
    ensureDefaultBank(instance);
    await mutateState(instance, (state) => {
      createMemory(state, {
        content: "this is proposed",
        scope: "project",
        confidence: 0.7,
        status: "proposed",
        sensitivity: "normal",
        provenance: "x"
      });
      createMemory(state, {
        content: "this is rejected",
        scope: "project",
        confidence: 0.7,
        status: "rejected",
        sensitivity: "normal",
        provenance: "y"
      });
    });
    const report = await migrateLegacyMemories(makeConfig(instance));
    expect(report.skipped).toBe(2);
    expect(report.migrated).toBe(0);
    expect(countMemoryUnits(instance)).toBe(0);
  });
});
