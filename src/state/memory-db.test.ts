import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  closeAllMemoryDbs,
  countByNetwork,
  countMemoryUnits,
  deserializeEmbedding,
  ensureDefaultBank,
  getMemoryDb,
  getMemoryUnit,
  insertEntity,
  insertLink,
  insertMemoryUnit,
  linkUnitToEntity,
  linksFrom,
  memoryDbPath,
  probeMemoryDb,
  removeMemoryDb,
  serializeEmbedding,
  DEFAULT_BANK_ID,
  MEMORY_SCHEMA_VERSION
} from "./memory-db";
import { resetInstance } from "../domain/runtime";
import { defaultConfig, instanceRoot } from "../paths";

// All tests share an isolated state root so they don't touch ~/.gini.
// Each test uses a unique instance name to avoid cross-test interference.
const ROOT = "/tmp/gini-memory-db-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  closeAllMemoryDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("memory-db schema and storage", () => {
  test("opens idempotently and records schema version", () => {
    const instance = "mem-init";
    // First open creates the file + schema; second open is a no-op.
    const a = getMemoryDb(instance);
    const b = getMemoryDb(instance);
    expect(a).toBe(b); // same handle, cached per instance
    const versionRow = a
      .query<{ value: string }, [string]>("SELECT value FROM schema_meta WHERE key = ?")
      .get("version");
    expect(versionRow?.value).toBe(String(MEMORY_SCHEMA_VERSION));

    // Reopening on a process restart (simulated by closing the cache and
    // calling getMemoryDb again) must NOT throw and must preserve the
    // schema version row.
    closeAllMemoryDbs();
    const reopened = getMemoryDb(instance);
    const versionAfter = reopened
      .query<{ value: string }, [string]>("SELECT value FROM schema_meta WHERE key = ?")
      .get("version");
    expect(versionAfter?.value).toBe(String(MEMORY_SCHEMA_VERSION));
  });

  test("ensureDefaultBank creates the default bank exactly once", () => {
    const instance = "mem-bank";
    const first = ensureDefaultBank(instance);
    expect(first.id).toBe(DEFAULT_BANK_ID);
    expect(first.skepticism).toBe(3);
    expect(first.literalism).toBe(3);
    expect(first.empathy).toBe(3);

    const second = ensureDefaultBank(instance);
    expect(second.id).toBe(first.id);

    const db = getMemoryDb(instance);
    const count = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_banks")
      .get()?.c;
    expect(count).toBe(1);
  });

  test("inserts a memory unit with embedding and round-trips Float32Array", () => {
    const instance = "mem-units";
    ensureDefaultBank(instance);

    const embedding = new Float32Array([0.1, -0.5, 1.25, 3.14159, -2.71828, 0.0]);
    const unit = insertMemoryUnit(instance, {
      text: "Gini ate the receipts.",
      embedding,
      embeddingModel: "test-embed-v0",
      network: "world",
      confidence: 0.9,
      metadata: { topic: "receipts", priority: 1 },
      sourceTaskId: "task_test"
    });

    expect(unit.embeddingDim).toBe(6);
    expect(unit.metadata.topic).toBe("receipts");

    const fetched = getMemoryUnit(instance, unit.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.text).toBe("Gini ate the receipts.");
    expect(fetched?.network).toBe("world");
    expect(fetched?.metadata.priority).toBe(1);
    expect(fetched?.embedding).not.toBeNull();
    expect(fetched?.embedding?.length).toBe(6);
    // Float32 round-trip is exact bit-for-bit; values should compare equal.
    for (let i = 0; i < embedding.length; i += 1) {
      expect(fetched!.embedding![i]).toBe(embedding[i]);
    }

    expect(countMemoryUnits(instance)).toBe(1);
  });

  test("serializeEmbedding/deserializeEmbedding survive a fresh ArrayBuffer", () => {
    // Direct round-trip without SQLite to lock in the buffer contract: even
    // when the source Float32Array is a slice of a larger buffer, the bytes
    // we serialize must be exactly the slice and deserializing must produce
    // an array with the same length and values.
    const big = new Float32Array(10);
    for (let i = 0; i < big.length; i += 1) big[i] = (i + 1) * 0.5;
    const slice = big.subarray(2, 6); // [1.5, 2.0, 2.5, 3.0]
    const buf = serializeEmbedding(slice);
    const back = deserializeEmbedding(buf, slice.length);
    expect(back).not.toBeNull();
    expect(back!.length).toBe(slice.length);
    for (let i = 0; i < slice.length; i += 1) expect(back![i]).toBe(slice[i]);
  });

  test("FTS5 mirror returns inserted text via MATCH queries", () => {
    const instance = "mem-fts";
    ensureDefaultBank(instance);
    const a = insertMemoryUnit(instance, {
      text: "The quick brown fox jumps over the lazy dog",
      network: "world"
    });
    insertMemoryUnit(instance, {
      text: "Pythagoras proved that the square of the hypotenuse",
      network: "world"
    });

    const db = getMemoryDb(instance);
    // FTS5 MATCH lookups return rowids that point back to memory_units. The
    // contentless FTS table approach means we have to JOIN to recover the row.
    const rows = db
      .query<{ id: string }, [string]>(
        `SELECT mu.id FROM memory_units_fts
         JOIN memory_units mu ON mu.rowid = memory_units_fts.rowid
         WHERE memory_units_fts MATCH ?`
      )
      .all("fox");
    expect(rows.map((row) => row.id)).toContain(a.id);
  });

  test("FTS index reflects deletions via the AFTER DELETE trigger", () => {
    const instance = "mem-fts-delete";
    ensureDefaultBank(instance);
    const unit = insertMemoryUnit(instance, {
      text: "Deletable observation about lemurs",
      network: "observation"
    });

    const db = getMemoryDb(instance);
    db.run("DELETE FROM memory_units WHERE id = ?", [unit.id]);
    const remaining = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM memory_units_fts WHERE memory_units_fts MATCH ?`
      )
      .get("lemurs")?.c;
    expect(remaining).toBe(0);
  });

  test("entities and links round-trip and respect indexes", () => {
    const instance = "mem-entities";
    ensureDefaultBank(instance);
    const fromUnit = insertMemoryUnit(instance, { text: "Alice met Bob in Paris.", network: "world" });
    const toUnit = insertMemoryUnit(instance, { text: "Bob later moved to Berlin.", network: "world" });

    const alice = insertEntity(instance, { canonicalName: "Alice", entityType: "PERSON" });
    const bob = insertEntity(instance, { canonicalName: "Bob", entityType: "PERSON" });

    linkUnitToEntity(instance, fromUnit.id, alice.id, "Alice");
    linkUnitToEntity(instance, fromUnit.id, bob.id, "Bob");
    linkUnitToEntity(instance, toUnit.id, bob.id, "Bob");
    // Duplicate insert is a no-op (PK + INSERT OR IGNORE).
    linkUnitToEntity(instance, toUnit.id, bob.id, "Bob");

    const db = getMemoryDb(instance);
    const mentionsForBob = db
      .query<{ unit_id: string }, [string]>("SELECT unit_id FROM entity_mentions WHERE entity_id = ?")
      .all(bob.id);
    expect(mentionsForBob.length).toBe(2);

    insertLink(instance, {
      fromUnit: fromUnit.id,
      toUnit: toUnit.id,
      linkType: "temporal",
      weight: 0.75
    });
    insertLink(instance, {
      fromUnit: fromUnit.id,
      toUnit: toUnit.id,
      linkType: "causal",
      causalSubtype: "causes",
      weight: 0.4
    });
    // Same pair + same link_type but DIFFERENT causal_subtype is a separate
    // row (subtype is part of the PK), so this should not collide.
    insertLink(instance, {
      fromUnit: fromUnit.id,
      toUnit: toUnit.id,
      linkType: "causal",
      causalSubtype: "enables",
      weight: 0.2
    });

    const allFrom = linksFrom(instance, fromUnit.id);
    expect(allFrom.length).toBe(3);
    const causalOnly = linksFrom(instance, fromUnit.id, "causal");
    expect(causalOnly.length).toBe(2);
    expect(causalOnly.map((link) => link.causalSubtype).sort()).toEqual(["causes", "enables"]);
  });

  test("link weight outside [0,1] is rejected before hitting SQL", () => {
    const instance = "mem-link-weight";
    ensureDefaultBank(instance);
    const a = insertMemoryUnit(instance, { text: "a", network: "world" });
    const b = insertMemoryUnit(instance, { text: "b", network: "world" });
    expect(() =>
      insertLink(instance, { fromUnit: a.id, toUnit: b.id, linkType: "semantic", weight: 1.5 })
    ).toThrow();
  });

  test("countByNetwork groups by the four-network vocabulary", () => {
    const instance = "mem-counts";
    ensureDefaultBank(instance);
    insertMemoryUnit(instance, { text: "world fact", network: "world" });
    insertMemoryUnit(instance, { text: "experience", network: "experience" });
    insertMemoryUnit(instance, { text: "experience 2", network: "experience" });
    insertMemoryUnit(instance, { text: "opinion", network: "opinion" });
    insertMemoryUnit(instance, { text: "observation", network: "observation" });

    const counts = countByNetwork(instance);
    expect(counts.world).toBe(1);
    expect(counts.experience).toBe(2);
    expect(counts.opinion).toBe(1);
    expect(counts.observation).toBe(1);
  });

  test("removeMemoryDb deletes the file and clears the cache", () => {
    const instance = "mem-remove";
    ensureDefaultBank(instance);
    insertMemoryUnit(instance, { text: "doomed", network: "world" });
    const path = memoryDbPath(instance);
    expect(existsSync(path)).toBe(true);

    removeMemoryDb(instance);
    expect(existsSync(path)).toBe(false);
    // WAL/SHM siblings must be gone too so a re-open starts truly fresh.
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);

    // Reopening after removal recreates the schema and the row count is 0.
    const fresh = getMemoryDb(instance);
    const c = fresh.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_units").get()?.c;
    expect(c).toBe(0);
  });

  test("resetInstance clears the memory DB and probe reports zero units", () => {
    const instance = "mem-reset";
    const config = { ...defaultConfig(instance), stateRoot: instanceRoot(instance) };
    ensureDefaultBank(instance);
    insertMemoryUnit(instance, { text: "to be wiped", network: "world" });
    expect(countMemoryUnits(instance)).toBe(1);

    resetInstance(config);

    // After reset, the instance root has been recreated by install(); the memory
    // DB is gone until the next ensureDefaultBank() / insert / probe call.
    const probe = probeMemoryDb(instance);
    expect(probe.ok).toBe(true);
    expect(probe.memoryUnits).toBe(0);
    expect(probe.banks).toBe(0);
    expect(probe.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
  });
});
