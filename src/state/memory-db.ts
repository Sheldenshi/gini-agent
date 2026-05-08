// Hindsight phase 1 — per-instance SQLite memory store (schema + scaffolding only).
//
// Adapted from vectorize-io/hindsight (MIT). See https://github.com/vectorize-io/hindsight
// The upstream service uses Postgres + pgvector; we re-implement the same
// four-network shape on top of bun:sqlite so Gini stays a single Bun binary
// with no external services. Schema follows the paper (Eq. 1, §3.1) and
// borrows the link-type and entity-type vocabulary from upstream.
//
// This module is additive in phase 1. The legacy in-state `MemoryRecord`
// store remains the source of truth for user-facing memory behavior. Phases
// 2-6 will build retain/recall/reflect/integration/migration on top of this
// schema.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Instance } from "../types";
import { instanceRoot } from "../paths";
import { id, now } from "./ids";

export const MEMORY_SCHEMA_VERSION = 1;
export const DEFAULT_BANK_ID = "bank_default";

export type Network = "world" | "experience" | "opinion" | "observation";
export type LinkType = "temporal" | "semantic" | "entity" | "causal";
export type CausalSubtype = "causes" | "caused_by" | "enables" | "prevents";
export type EntityType =
  | "PERSON"
  | "ORGANIZATION"
  | "LOCATION"
  | "PRODUCT"
  | "CONCEPT"
  | "OTHER";
export type MemoryUnitStatus =
  | "proposed"
  | "active"
  | "archived"
  | "rejected"
  | "conflicted";

export interface MemoryBank {
  id: string;
  name: string;
  agentName: string | null;
  background: string | null;
  skepticism: number;
  literalism: number;
  empathy: number;
  biasStrength: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryUnit {
  id: string;
  bankId: string;
  text: string;
  embedding: Float32Array | null;
  embeddingDim: number | null;
  embeddingModel: string | null;
  occurredStart: string | null;
  occurredEnd: string | null;
  mentionedAt: string;
  network: Network;
  confidence: number | null;
  metadata: Record<string, unknown>;
  sourceTaskId: string | null;
  sourceSessionId: string | null;
  status: MemoryUnitStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  usageCount: number;
}

export interface Entity {
  id: string;
  bankId: string;
  canonicalName: string;
  entityType: EntityType;
  createdAt: string;
}

export interface EntityMention {
  unitId: string;
  entityId: string;
  surface: string;
}

export interface MemoryLink {
  fromUnit: string;
  toUnit: string;
  linkType: LinkType;
  weight: number;
  causalSubtype: CausalSubtype | null;
  entityId: string | null;
}

export function memoryDbPath(instance: Instance): string {
  return join(instanceRoot(instance), "memory.db");
}

// Per-instance Database handle cache. bun:sqlite handles are cheap to keep open,
// and reusing them lets prepared statements stay hot across requests within
// a single CLI/runtime process. Reset clears the entry so callers get a fresh
// handle pointing at the recreated file.
const dbCache = new Map<Instance, Database>();

export function getMemoryDb(instance: Instance): Database {
  const cached = dbCache.get(instance);
  if (cached) return cached;
  mkdirSync(instanceRoot(instance), { recursive: true });
  const db = new Database(memoryDbPath(instance), { create: true });
  // WAL gives us non-blocking reads while a writer holds the lock and is the
  // standard recommendation for SQLite under concurrent access. NORMAL sync
  // is fine for a local memory store — a hard crash would lose at most the
  // last few transactions, and the legacy JSON store remains authoritative
  // for now.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  dbCache.set(instance, db);
  return db;
}

export function closeMemoryDb(instance: Instance): void {
  const cached = dbCache.get(instance);
  if (!cached) return;
  try { cached.close(); } catch { /* already closed */ }
  dbCache.delete(instance);
}

export function closeAllMemoryDbs(): void {
  for (const instance of [...dbCache.keys()]) closeMemoryDb(instance);
}

// Removes the on-disk SQLite file (and its WAL/SHM siblings) for a instance,
// closing the cached handle first so the OS releases the descriptors. Called
// by instance reset/destroy; safe to call when the file does not exist.
export function removeMemoryDb(instance: Instance): void {
  closeMemoryDb(instance);
  const path = memoryDbPath(instance);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

// Migrations run on every open via CREATE ... IF NOT EXISTS so reopening is
// always safe. The schema_meta row records the current version for future
// rounds — phase 2+ may need data migrations rather than just additive DDL.
function applyMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_banks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_name TEXT,
      background TEXT,
      skepticism INTEGER NOT NULL DEFAULT 3,
      literalism INTEGER NOT NULL DEFAULT 3,
      empathy INTEGER NOT NULL DEFAULT 3,
      bias_strength REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Eq. 1 (paper §3.1): a memory unit is text + provenance + temporal scope
    -- + a network label drawn from {world, experience, opinion, observation}.
    CREATE TABLE IF NOT EXISTS memory_units (
      id TEXT PRIMARY KEY,
      bank_id TEXT NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      embedding BLOB,
      embedding_dim INTEGER,
      embedding_model TEXT,
      occurred_start TEXT,
      occurred_end TEXT,
      mentioned_at TEXT NOT NULL,
      network TEXT NOT NULL CHECK (network IN ('world','experience','opinion','observation')),
      confidence REAL,
      metadata TEXT NOT NULL DEFAULT '{}',
      source_task_id TEXT,
      source_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','archived','rejected','conflicted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_memory_units_bank ON memory_units(bank_id);
    CREATE INDEX IF NOT EXISTS idx_memory_units_network ON memory_units(bank_id, network);
    CREATE INDEX IF NOT EXISTS idx_memory_units_temporal ON memory_units(bank_id, occurred_start, occurred_end);
    CREATE INDEX IF NOT EXISTS idx_memory_units_status ON memory_units(bank_id, status);

    -- BM25 (paper Eq. 11) — FTS5 mirror of memory_units.text, kept in sync via
    -- triggers so retain/recall (phases 2-3) can run lexical queries without
    -- maintaining a parallel index. content='memory_units' makes the FTS table
    -- a contentless mirror that points back at the source rowid.
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_units_fts USING fts5(
      text, content='memory_units', content_rowid='rowid', tokenize='porter'
    );

    CREATE TRIGGER IF NOT EXISTS memory_units_ai AFTER INSERT ON memory_units BEGIN
      INSERT INTO memory_units_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_units_ad AFTER DELETE ON memory_units BEGIN
      INSERT INTO memory_units_fts(memory_units_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_units_au AFTER UPDATE ON memory_units BEGIN
      INSERT INTO memory_units_fts(memory_units_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      INSERT INTO memory_units_fts(rowid, text) VALUES (new.rowid, new.text);
    END;

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      bank_id TEXT NOT NULL REFERENCES memory_banks(id) ON DELETE CASCADE,
      canonical_name TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('PERSON','ORGANIZATION','LOCATION','PRODUCT','CONCEPT','OTHER')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entities_bank_name ON entities(bank_id, canonical_name);

    CREATE TABLE IF NOT EXISTS entity_mentions (
      unit_id TEXT NOT NULL REFERENCES memory_units(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      surface TEXT NOT NULL,
      PRIMARY KEY (unit_id, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(entity_id);

    -- Causal links share the row shape with the other link types but carry a
    -- subtype drawn from {causes, caused_by, enables, prevents} (paper Eq. 4).
    -- Including causal_subtype in the PK lets multiple causal edges between
    -- the same pair coexist (e.g. A causes B and A enables B).
    CREATE TABLE IF NOT EXISTS memory_links (
      from_unit TEXT NOT NULL REFERENCES memory_units(id) ON DELETE CASCADE,
      to_unit TEXT NOT NULL REFERENCES memory_units(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL CHECK (link_type IN ('temporal','semantic','entity','causal')),
      weight REAL NOT NULL CHECK (weight >= 0.0 AND weight <= 1.0),
      causal_subtype TEXT CHECK (causal_subtype IN ('causes','caused_by','enables','prevents')),
      entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (from_unit, to_unit, link_type, causal_subtype)
    );
    CREATE INDEX IF NOT EXISTS idx_links_from ON memory_links(from_unit, link_type);
    CREATE INDEX IF NOT EXISTS idx_links_to ON memory_links(to_unit, link_type);
    CREATE INDEX IF NOT EXISTS idx_links_entity ON memory_links(entity_id) WHERE entity_id IS NOT NULL;
  `);

  db.run(
    "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('version', ?)",
    [String(MEMORY_SCHEMA_VERSION)]
  );
}

// Float32Array <-> Buffer round-trip.
//
// Quirk worth noting for phase 2: bun:sqlite returns BLOBs as a Uint8Array
// (NOT a Node Buffer) whose .buffer may have a non-zero byteOffset because
// it shares an underlying ArrayBuffer with sibling rows in the result set.
// We must slice on byteOffset/byteLength before constructing the Float32Array
// or we'll either misalign or read past the end of the row's bytes.
export function serializeEmbedding(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function deserializeEmbedding(
  blob: Uint8Array | Buffer | null | undefined,
  dim: number | null | undefined
): Float32Array | null {
  if (!blob || !dim) return null;
  // Copy into a fresh ArrayBuffer to detach from sqlite's row-shared buffer
  // and to guarantee 4-byte alignment for Float32Array's underlying buffer.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, dim);
}

// --------------------------------------------------------------------------
// Bank helpers
// --------------------------------------------------------------------------

export function ensureDefaultBank(instance: Instance): MemoryBank {
  const db = getMemoryDb(instance);
  const existing = db
    .query<MemoryBankRow, [string]>("SELECT * FROM memory_banks WHERE id = ?")
    .get(DEFAULT_BANK_ID);
  if (existing) return rowToBank(existing);
  const at = now();
  const bank: MemoryBank = {
    id: DEFAULT_BANK_ID,
    name: "default",
    agentName: null,
    background: null,
    skepticism: 3,
    literalism: 3,
    empathy: 3,
    biasStrength: 0.5,
    createdAt: at,
    updatedAt: at
  };
  db.run(
    `INSERT INTO memory_banks
       (id, name, agent_name, background, skepticism, literalism, empathy, bias_strength, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [bank.id, bank.name, bank.agentName, bank.background, bank.skepticism, bank.literalism, bank.empathy, bank.biasStrength, bank.createdAt, bank.updatedAt]
  );
  return bank;
}

export function listBanks(instance: Instance): MemoryBank[] {
  const db = getMemoryDb(instance);
  return db
    .query<MemoryBankRow, []>("SELECT * FROM memory_banks ORDER BY created_at ASC")
    .all()
    .map(rowToBank);
}

// --------------------------------------------------------------------------
// Memory unit helpers (minimal — phase 2 will expand insertion APIs)
// --------------------------------------------------------------------------

export interface InsertMemoryUnitInput {
  bankId?: string;
  text: string;
  embedding?: Float32Array | null;
  embeddingModel?: string | null;
  occurredStart?: string | null;
  occurredEnd?: string | null;
  mentionedAt?: string;
  network: Network;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
  sourceTaskId?: string | null;
  sourceSessionId?: string | null;
  status?: MemoryUnitStatus;
}

export function insertMemoryUnit(instance: Instance, input: InsertMemoryUnitInput): MemoryUnit {
  const db = getMemoryDb(instance);
  const at = now();
  const unit: MemoryUnit = {
    id: id("mu"),
    bankId: input.bankId ?? DEFAULT_BANK_ID,
    text: input.text,
    embedding: input.embedding ?? null,
    embeddingDim: input.embedding ? input.embedding.length : null,
    embeddingModel: input.embeddingModel ?? null,
    occurredStart: input.occurredStart ?? null,
    occurredEnd: input.occurredEnd ?? null,
    mentionedAt: input.mentionedAt ?? at,
    network: input.network,
    confidence: input.confidence ?? null,
    metadata: input.metadata ?? {},
    sourceTaskId: input.sourceTaskId ?? null,
    sourceSessionId: input.sourceSessionId ?? null,
    status: input.status ?? "active",
    createdAt: at,
    updatedAt: at,
    lastUsedAt: null,
    usageCount: 0
  };
  db.run(
    `INSERT INTO memory_units
       (id, bank_id, text, embedding, embedding_dim, embedding_model,
        occurred_start, occurred_end, mentioned_at, network, confidence,
        metadata, source_task_id, source_session_id, status,
        created_at, updated_at, last_used_at, usage_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      unit.id,
      unit.bankId,
      unit.text,
      unit.embedding ? serializeEmbedding(unit.embedding) : null,
      unit.embeddingDim,
      unit.embeddingModel,
      unit.occurredStart,
      unit.occurredEnd,
      unit.mentionedAt,
      unit.network,
      unit.confidence,
      JSON.stringify(unit.metadata),
      unit.sourceTaskId,
      unit.sourceSessionId,
      unit.status,
      unit.createdAt,
      unit.updatedAt,
      unit.lastUsedAt,
      unit.usageCount
    ]
  );
  return unit;
}

export function getMemoryUnit(instance: Instance, unitId: string): MemoryUnit | null {
  const db = getMemoryDb(instance);
  const row = db
    .query<MemoryUnitRow, [string]>("SELECT * FROM memory_units WHERE id = ?")
    .get(unitId);
  return row ? rowToUnit(row) : null;
}

// Active units in a bank, sorted by mentioned_at DESC. Optional `limit` caps
// the candidate pool — phases 2-3 use this to bound the brute-force semantic
// scan to a recent window. Optional `network` filter narrows to a single
// network (e.g. opinions only, world facts only).
export interface ListUnitsOptions {
  network?: Network | Network[];
  status?: MemoryUnitStatus | MemoryUnitStatus[];
  limit?: number;
  excludeIds?: string[];
}

export function listMemoryUnits(instance: Instance, bankId: string, options: ListUnitsOptions = {}): MemoryUnit[] {
  const db = getMemoryDb(instance);
  const where: string[] = ["bank_id = ?"];
  const params: (string | number | null)[] = [bankId];
  const status = options.status ?? "active";
  const statuses = Array.isArray(status) ? status : [status];
  if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  if (options.network) {
    const networks = Array.isArray(options.network) ? options.network : [options.network];
    if (networks.length > 0) {
      where.push(`network IN (${networks.map(() => "?").join(",")})`);
      params.push(...networks);
    }
  }
  if (options.excludeIds && options.excludeIds.length > 0) {
    where.push(`id NOT IN (${options.excludeIds.map(() => "?").join(",")})`);
    params.push(...options.excludeIds);
  }
  let sql = `SELECT * FROM memory_units WHERE ${where.join(" AND ")} ORDER BY mentioned_at DESC`;
  if (typeof options.limit === "number") {
    sql += ` LIMIT ${Math.max(0, Math.floor(options.limit))}`;
  }
  return db.query<MemoryUnitRow, (string | number | null)[]>(sql).all(...params).map(rowToUnit);
}

export function recentMemoryUnitIds(instance: Instance, bankId: string, limit: number): string[] {
  const db = getMemoryDb(instance);
  return db
    .query<{ id: string }, [string, number]>(
      "SELECT id FROM memory_units WHERE bank_id = ? AND status = 'active' ORDER BY mentioned_at DESC LIMIT ?"
    )
    .all(bankId, limit)
    .map((row) => row.id);
}

// Returns memory units that mention a given entity, ordered most-recent
// first. Used by observation regeneration (phase 2.4) and recall.
export function unitsForEntity(instance: Instance, entityId: string, limit?: number): MemoryUnit[] {
  const db = getMemoryDb(instance);
  const sql = `SELECT mu.* FROM memory_units mu
               JOIN entity_mentions em ON em.unit_id = mu.id
               WHERE em.entity_id = ? AND mu.status = 'active'
               ORDER BY mu.mentioned_at DESC
               ${typeof limit === "number" ? `LIMIT ${Math.max(0, Math.floor(limit))}` : ""}`;
  return db.query<MemoryUnitRow, [string]>(sql).all(entityId).map(rowToUnit);
}

// Used by observation regeneration to upsert a single observation row per
// (bank, entity) pair. Implementation: archive any prior observation for the
// entity, insert the new one with metadata.entityId set.
export function upsertObservationUnit(
  instance: Instance,
  bankId: string,
  entityId: string,
  text: string,
  embedding: Float32Array | null,
  embeddingModel: string | null
): MemoryUnit {
  const db = getMemoryDb(instance);
  // Archive any existing observation rows for this entity in this bank.
  db.run(
    `UPDATE memory_units SET status = 'archived', updated_at = ?
     WHERE bank_id = ? AND network = 'observation' AND status = 'active'
       AND id IN (
         SELECT mu.id FROM memory_units mu
         JOIN entity_mentions em ON em.unit_id = mu.id
         WHERE em.entity_id = ?
       )`,
    [now(), bankId, entityId]
  );
  const unit = insertMemoryUnit(instance, {
    bankId,
    text,
    embedding,
    embeddingModel,
    network: "observation",
    metadata: { entityId }
  });
  linkUnitToEntity(instance, unit.id, entityId, text.slice(0, 80));
  return unit;
}

export function updateMemoryUnitConfidence(
  instance: Instance,
  unitId: string,
  confidence: number | null
): void {
  const db = getMemoryDb(instance);
  db.run(
    "UPDATE memory_units SET confidence = ?, updated_at = ? WHERE id = ?",
    [confidence, now(), unitId]
  );
}

export interface UpdateUnitStatsOptions {
  status?: MemoryUnitStatus;
  lastUsedAt?: string;
  bumpUsageCount?: boolean;
}

export function updateMemoryUnitStats(
  instance: Instance,
  unitId: string,
  options: UpdateUnitStatsOptions
): void {
  const db = getMemoryDb(instance);
  const fragments: string[] = [];
  const params: (string | number | null)[] = [];
  if (options.status) {
    fragments.push("status = ?");
    params.push(options.status);
  }
  if (options.lastUsedAt) {
    fragments.push("last_used_at = ?");
    params.push(options.lastUsedAt);
  }
  if (options.bumpUsageCount) {
    fragments.push("usage_count = usage_count + 1");
  }
  if (fragments.length === 0) return;
  fragments.push("updated_at = ?");
  params.push(now());
  params.push(unitId);
  db.run(`UPDATE memory_units SET ${fragments.join(", ")} WHERE id = ?`, params);
}

export function findEntitiesByMentions(instance: Instance, unitId: string): Entity[] {
  const db = getMemoryDb(instance);
  return db
    .query<{ id: string; bank_id: string; canonical_name: string; entity_type: EntityType; created_at: string }, [string]>(
      `SELECT e.* FROM entities e
       JOIN entity_mentions em ON em.entity_id = e.id
       WHERE em.unit_id = ?`
    )
    .all(unitId)
    .map((row) => ({
      id: row.id,
      bankId: row.bank_id,
      canonicalName: row.canonical_name,
      entityType: row.entity_type,
      createdAt: row.created_at
    }));
}

export function entityMentionsForUnit(instance: Instance, unitId: string): EntityMention[] {
  const db = getMemoryDb(instance);
  return db
    .query<{ unit_id: string; entity_id: string; surface: string }, [string]>(
      "SELECT * FROM entity_mentions WHERE unit_id = ?"
    )
    .all(unitId)
    .map((row) => ({ unitId: row.unit_id, entityId: row.entity_id, surface: row.surface }));
}

// Listing memory links from a set of seed unit IDs (used by recall's graph
// channel). One round-trip per seed keeps the SQL simple and avoids needing
// a recursive CTE for two-hop expansion.
export function linksFromMany(instance: Instance, unitIds: string[]): MemoryLink[] {
  if (unitIds.length === 0) return [];
  const db = getMemoryDb(instance);
  const placeholders = unitIds.map(() => "?").join(",");
  return db
    .query<MemoryLinkRow, string[]>(
      `SELECT * FROM memory_links WHERE from_unit IN (${placeholders})`
    )
    .all(...unitIds)
    .map(rowToLink);
}

export function getBank(instance: Instance, bankId: string): MemoryBank | null {
  const db = getMemoryDb(instance);
  const row = db
    .query<MemoryBankRow, [string]>("SELECT * FROM memory_banks WHERE id = ?")
    .get(bankId);
  return row ? rowToBank(row) : null;
}

export interface UpdateBankInput {
  name?: string;
  agentName?: string | null;
  background?: string | null;
  skepticism?: number;
  literalism?: number;
  empathy?: number;
  biasStrength?: number;
}

export function updateBank(instance: Instance, bankId: string, patch: UpdateBankInput): MemoryBank | null {
  const db = getMemoryDb(instance);
  const fragments: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.name !== undefined) { fragments.push("name = ?"); params.push(patch.name); }
  if (patch.agentName !== undefined) { fragments.push("agent_name = ?"); params.push(patch.agentName); }
  if (patch.background !== undefined) { fragments.push("background = ?"); params.push(patch.background); }
  if (typeof patch.skepticism === "number") { fragments.push("skepticism = ?"); params.push(clampInt(patch.skepticism, 1, 5)); }
  if (typeof patch.literalism === "number") { fragments.push("literalism = ?"); params.push(clampInt(patch.literalism, 1, 5)); }
  if (typeof patch.empathy === "number") { fragments.push("empathy = ?"); params.push(clampInt(patch.empathy, 1, 5)); }
  if (typeof patch.biasStrength === "number") { fragments.push("bias_strength = ?"); params.push(Math.max(0, Math.min(1, patch.biasStrength))); }
  if (fragments.length === 0) return getBank(instance, bankId);
  fragments.push("updated_at = ?");
  params.push(now());
  params.push(bankId);
  db.run(`UPDATE memory_banks SET ${fragments.join(", ")} WHERE id = ?`, params);
  return getBank(instance, bankId);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function countMemoryUnits(instance: Instance): number {
  const db = getMemoryDb(instance);
  const row = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_units")
    .get();
  return row?.c ?? 0;
}

export interface NetworkCounts {
  world: number;
  experience: number;
  opinion: number;
  observation: number;
}

// Per-bank histogram of embedding_model -> active unit count. Used by
// `gini embedding status` and `gini doctor` to surface model mixing — a
// bank with units across multiple models has stale vectors that semantic
// recall will skip until reembedded.
export interface EmbeddingModelCount {
  bankId: string;
  embeddingModel: string | null;
  count: number;
}

export function countUnitsByEmbeddingModel(instance: Instance, bankId?: string): EmbeddingModelCount[] {
  const db = getMemoryDb(instance);
  const rows = bankId
    ? db
        .query<{ bank_id: string; embedding_model: string | null; c: number }, [string]>(
          `SELECT bank_id, embedding_model, COUNT(*) AS c
           FROM memory_units
           WHERE status = 'active' AND bank_id = ?
           GROUP BY bank_id, embedding_model
           ORDER BY bank_id, c DESC`
        )
        .all(bankId)
    : db
        .query<{ bank_id: string; embedding_model: string | null; c: number }, []>(
          `SELECT bank_id, embedding_model, COUNT(*) AS c
           FROM memory_units
           WHERE status = 'active'
           GROUP BY bank_id, embedding_model
           ORDER BY bank_id, c DESC`
        )
        .all();
  return rows.map((row) => ({ bankId: row.bank_id, embeddingModel: row.embedding_model, count: row.c }));
}

// Update the embedding/embedding_dim/embedding_model triple for an existing
// unit. Used by the reembed CLI to swap vectors after a provider change.
// Pass null/null/null to clear (e.g. for migration). updated_at is bumped.
export function updateMemoryUnitEmbedding(
  instance: Instance,
  unitId: string,
  embedding: Float32Array | null,
  embeddingModel: string | null
): void {
  const db = getMemoryDb(instance);
  db.run(
    `UPDATE memory_units
     SET embedding = ?, embedding_dim = ?, embedding_model = ?, updated_at = ?
     WHERE id = ?`,
    [
      embedding ? serializeEmbedding(embedding) : null,
      embedding ? embedding.length : null,
      embeddingModel,
      now(),
      unitId
    ]
  );
}

export function countByNetwork(instance: Instance): NetworkCounts {
  const db = getMemoryDb(instance);
  const counts: NetworkCounts = { world: 0, experience: 0, opinion: 0, observation: 0 };
  const rows = db
    .query<{ network: Network; c: number }, []>(
      "SELECT network, COUNT(*) AS c FROM memory_units GROUP BY network"
    )
    .all();
  for (const row of rows) counts[row.network] = row.c;
  return counts;
}

// --------------------------------------------------------------------------
// Entity + link helpers
// --------------------------------------------------------------------------

export interface InsertEntityInput {
  bankId?: string;
  canonicalName: string;
  entityType: EntityType;
}

export function insertEntity(instance: Instance, input: InsertEntityInput): Entity {
  const db = getMemoryDb(instance);
  const entity: Entity = {
    id: id("ent"),
    bankId: input.bankId ?? DEFAULT_BANK_ID,
    canonicalName: input.canonicalName,
    entityType: input.entityType,
    createdAt: now()
  };
  db.run(
    `INSERT INTO entities (id, bank_id, canonical_name, entity_type, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [entity.id, entity.bankId, entity.canonicalName, entity.entityType, entity.createdAt]
  );
  return entity;
}

export function linkUnitToEntity(
  instance: Instance,
  unitId: string,
  entityId: string,
  surface: string
): EntityMention {
  const db = getMemoryDb(instance);
  db.run(
    `INSERT OR IGNORE INTO entity_mentions (unit_id, entity_id, surface) VALUES (?, ?, ?)`,
    [unitId, entityId, surface]
  );
  return { unitId, entityId, surface };
}

export interface InsertLinkInput {
  fromUnit: string;
  toUnit: string;
  linkType: LinkType;
  weight: number;
  causalSubtype?: CausalSubtype | null;
  entityId?: string | null;
}

export function insertLink(instance: Instance, input: InsertLinkInput): MemoryLink {
  if (input.weight < 0 || input.weight > 1) {
    throw new Error(`memory link weight must be in [0,1], got ${input.weight}`);
  }
  const link: MemoryLink = {
    fromUnit: input.fromUnit,
    toUnit: input.toUnit,
    linkType: input.linkType,
    weight: input.weight,
    causalSubtype: input.causalSubtype ?? null,
    entityId: input.entityId ?? null
  };
  const db = getMemoryDb(instance);
  db.run(
    `INSERT OR REPLACE INTO memory_links
       (from_unit, to_unit, link_type, weight, causal_subtype, entity_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      link.fromUnit,
      link.toUnit,
      link.linkType,
      link.weight,
      link.causalSubtype,
      link.entityId,
      now()
    ]
  );
  return link;
}

export function linksFrom(instance: Instance, unitId: string, linkType?: LinkType): MemoryLink[] {
  const db = getMemoryDb(instance);
  const rows = linkType
    ? db
        .query<MemoryLinkRow, [string, string]>(
          "SELECT * FROM memory_links WHERE from_unit = ? AND link_type = ?"
        )
        .all(unitId, linkType)
    : db
        .query<MemoryLinkRow, [string]>(
          "SELECT * FROM memory_links WHERE from_unit = ?"
        )
        .all(unitId);
  return rows.map(rowToLink);
}

// --------------------------------------------------------------------------
// Row <-> object marshaling
// --------------------------------------------------------------------------

interface MemoryBankRow {
  id: string;
  name: string;
  agent_name: string | null;
  background: string | null;
  skepticism: number;
  literalism: number;
  empathy: number;
  bias_strength: number;
  created_at: string;
  updated_at: string;
}

interface MemoryUnitRow {
  id: string;
  bank_id: string;
  text: string;
  embedding: Uint8Array | null;
  embedding_dim: number | null;
  embedding_model: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  mentioned_at: string;
  network: Network;
  confidence: number | null;
  metadata: string;
  source_task_id: string | null;
  source_session_id: string | null;
  status: MemoryUnitStatus;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  usage_count: number;
}

interface MemoryLinkRow {
  from_unit: string;
  to_unit: string;
  link_type: LinkType;
  weight: number;
  causal_subtype: CausalSubtype | null;
  entity_id: string | null;
  created_at: string;
}

function rowToBank(row: MemoryBankRow): MemoryBank {
  return {
    id: row.id,
    name: row.name,
    agentName: row.agent_name,
    background: row.background,
    skepticism: row.skepticism,
    literalism: row.literalism,
    empathy: row.empathy,
    biasStrength: row.bias_strength,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToUnit(row: MemoryUnitRow): MemoryUnit {
  let metadata: Record<string, unknown> = {};
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; }
    catch { metadata = {}; }
  }
  return {
    id: row.id,
    bankId: row.bank_id,
    text: row.text,
    embedding: deserializeEmbedding(row.embedding, row.embedding_dim),
    embeddingDim: row.embedding_dim,
    embeddingModel: row.embedding_model,
    occurredStart: row.occurred_start,
    occurredEnd: row.occurred_end,
    mentionedAt: row.mentioned_at,
    network: row.network,
    confidence: row.confidence,
    metadata,
    sourceTaskId: row.source_task_id,
    sourceSessionId: row.source_session_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    usageCount: row.usage_count
  };
}

function rowToLink(row: MemoryLinkRow): MemoryLink {
  return {
    fromUnit: row.from_unit,
    toUnit: row.to_unit,
    linkType: row.link_type,
    weight: row.weight,
    causalSubtype: row.causal_subtype,
    entityId: row.entity_id
  };
}

// Probe used by `gini doctor`. Reports ok=true even on a brand-new instance
// (the tables exist after migration); ok=false only if something breaks.
export interface MemoryDbProbe {
  ok: boolean;
  path: string;
  exists: boolean;
  schemaVersion: number | null;
  banks: number;
  memoryUnits: number;
  byNetwork: NetworkCounts;
  entities: number;
  links: number;
  error?: string;
}

export function probeMemoryDb(instance: Instance): MemoryDbProbe {
  const path = memoryDbPath(instance);
  const exists = existsSync(path);
  try {
    const db = getMemoryDb(instance);
    const versionRow = db
      .query<{ value: string }, [string]>("SELECT value FROM schema_meta WHERE key = ?")
      .get("version");
    const banks = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_banks").get()?.c ?? 0;
    const memoryUnits = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_units").get()?.c ?? 0;
    const entities = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM entities").get()?.c ?? 0;
    const links = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM memory_links").get()?.c ?? 0;
    return {
      ok: true,
      path,
      exists,
      schemaVersion: versionRow ? Number(versionRow.value) : null,
      banks,
      memoryUnits,
      byNetwork: countByNetwork(instance),
      entities,
      links
    };
  } catch (error) {
    return {
      ok: false,
      path,
      exists,
      schemaVersion: null,
      banks: 0,
      memoryUnits: 0,
      byNetwork: { world: 0, experience: 0, opinion: 0, observation: 0 },
      entities: 0,
      links: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
