// Per-agent structured datastore — the storage layer behind the agent-database
// primitive (ADR agent-database.md). Each agent gets its OWN SQLite file under
// the instance (agent-data/<agentId>.db), fully isolated from Gini's system
// databases (memory.db, state). The agent designs its own schema and runs its
// own SQL through the db_query / db_execute / db_import tools, so it can keep
// and exhaustively query structured records (contacts, expenses, job apps,
// reading lists, …) — the access pattern Hindsight recall deliberately can't
// serve (it is ranked/top-K/fuzzy; this is exact relational query).
//
// Isolation IS the safety boundary: a separate file per agent means agent SQL
// can never reach another agent's data, Gini's memory/state, or secrets. The
// read tool is SELECT-only and ATTACH/DETACH/load_extension are rejected so the
// sandbox can't be widened to reach those other files.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Instance } from "../types";
import { instanceRoot } from "../paths";

// Cap rows returned to the model so an unbounded SELECT can't flood the context.
// The DB query itself is exhaustive; this only bounds what is materialized back
// to the caller, who should COUNT / aggregate / paginate for larger sets.
export const MAX_RESULT_ROWS = 1000;

const cache = new Map<string, Database>();
// Separate read-only handles back db_query. Enforcing read-only at the SQLite
// connection (not just a regex) closes write vectors a prefix check can miss —
// e.g. `WITH t AS (…) INSERT …`, which begins with WITH yet mutates.
const readonlyCache = new Map<string, Database>();

function sanitizeAgentId(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!safe) throw new Error("Invalid agent id for data store.");
  return safe;
}

export function agentDataDbPath(instance: Instance, agentId: string): string {
  return join(instanceRoot(instance), "agent-data", `${sanitizeAgentId(agentId)}.db`);
}

export function getAgentDataDb(instance: Instance, agentId: string): Database {
  const key = `${instance}:${agentId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  mkdirSync(join(instanceRoot(instance), "agent-data"), { recursive: true });
  const db = new Database(agentDataDbPath(instance, agentId), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  cache.set(key, db);
  return db;
}

// A read-only connection to the same per-agent file, opened lazily after the
// write handle has created the file. Used only by dbQuery.
function getAgentDataDbReadonly(instance: Instance, agentId: string): Database {
  const key = `${instance}:${agentId}`;
  const cached = readonlyCache.get(key);
  if (cached) return cached;
  getAgentDataDb(instance, agentId); // ensure the file (and WAL) exist
  const db = new Database(agentDataDbPath(instance, agentId), { readonly: true });
  readonlyCache.set(key, db);
  return db;
}

export function closeAgentDataDb(instance: Instance, agentId: string): void {
  const key = `${instance}:${agentId}`;
  for (const map of [cache, readonlyCache]) {
    const db = map.get(key);
    if (db) {
      try { db.close(); } catch { /* already closed */ }
      map.delete(key);
    }
  }
}

export function closeAllAgentDataDbs(): void {
  for (const map of [cache, readonlyCache]) {
    // Snapshot keys first — deleting from a Map mid-iteration can skip entries.
    for (const key of [...map.keys()]) {
      const db = map.get(key);
      if (db) {
        try { db.close(); } catch { /* already closed */ }
      }
      map.delete(key);
    }
  }
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

export interface ExecuteResult {
  changes: number;
  lastInsertRowid: number;
}

export interface TableInfo {
  name: string;
  columns: Array<{ name: string; type: string }>;
  rowCount: number;
}

export class AgentDataError extends Error {}

// Statements that would let the sandbox reach beyond its own file. Rejected on
// both query and execute regardless of read/write classification.
const ESCAPE_PATTERN = /\b(attach|detach)\s+database\b|load_extension\s*\(/i;

function assertNoEscape(sql: string): void {
  if (ESCAPE_PATTERN.test(sql)) {
    throw new AgentDataError("ATTACH/DETACH/load_extension are not allowed in the data store.");
  }
}

// True when `sql` holds more than one statement: a `;` outside any string
// literal with non-whitespace after it. Quote-aware so a literal semicolon
// (e.g. INSERT … VALUES (';')) is NOT mistaken for a separator.
function hasStatementSeparator(sql: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inSingle) {
      if (c === "'") { if (sql[i + 1] === "'") { i++; continue; } inSingle = false; }
      continue;
    }
    if (inDouble) {
      if (c === '"') { if (sql[i + 1] === '"') { i++; continue; } inDouble = false; }
      continue;
    }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === ";" && sql.slice(i + 1).trim().length > 0) return true;
  }
  return false;
}

// Drop a single trailing semicolon, then reject if a real statement separator
// remains — db_query and db_execute each run ONE statement so a query can't
// smuggle a second (write) statement past the read-only gate.
function singleStatement(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (hasStatementSeparator(trimmed)) {
    throw new AgentDataError("Only one SQL statement per call. Split multiple statements into separate calls.");
  }
  return trimmed;
}

// Read-only query. Rejects anything that isn't a SELECT / WITH / read-only
// PRAGMA so writes can only go through db_execute (which is audited).
export function dbQuery(
  instance: Instance,
  agentId: string,
  sql: string,
  params: unknown[] = []
): QueryResult {
  const stmt = singleStatement(sql);
  assertNoEscape(stmt);
  if (!/^\s*(select|with|pragma\s+table_info|pragma\s+table_list)\b/i.test(stmt)) {
    throw new AgentDataError("db_query is read-only — it accepts SELECT / WITH. Use db_execute for writes or DDL.");
  }
  // Run on the read-only connection so even a write smuggled behind a CTE
  // (WITH … INSERT) fails at the engine rather than relying on the regex.
  const db = getAgentDataDbReadonly(instance, agentId);
  let all: Array<Record<string, unknown>>;
  try {
    all = db.query(stmt).all(...(params as never[])) as Array<Record<string, unknown>>;
  } catch (error) {
    throw new AgentDataError(error instanceof Error ? error.message : String(error));
  }
  const truncated = all.length > MAX_RESULT_ROWS;
  const rows = truncated ? all.slice(0, MAX_RESULT_ROWS) : all;
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
  return { columns, rows, rowCount: rows.length, truncated };
}

// Execute one DDL/DML statement (CREATE/ALTER/DROP/INSERT/UPDATE/DELETE …).
export function dbExecute(
  instance: Instance,
  agentId: string,
  sql: string,
  params: unknown[] = []
): ExecuteResult {
  const stmt = singleStatement(sql);
  assertNoEscape(stmt);
  const db = getAgentDataDb(instance, agentId);
  try {
    const result = db.run(stmt, ...(params as never[]));
    return { changes: Number(result.changes ?? 0), lastInsertRowid: Number(result.lastInsertRowid ?? 0) };
  } catch (error) {
    throw new AgentDataError(error instanceof Error ? error.message : String(error));
  }
}

// Introspection: the tables the agent has created and their columns + row
// counts, so the agent can recall what it's already tracking.
export function dbListTables(instance: Instance, agentId: string): TableInfo[] {
  const db = getAgentDataDb(instance, agentId);
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all();
  return tables.map((t) => {
    const columns = db
      .query<{ name: string; type: string }, [string]>("SELECT name, type FROM pragma_table_info(?)")
      .all(t.name)
      .map((c) => ({ name: c.name, type: c.type || "TEXT" }));
    let rowCount = 0;
    try {
      // Table name comes from sqlite_master (not user input), so the interpolation
      // is safe; bound params aren't allowed for identifiers.
      const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get();
      rowCount = row?.n ?? 0;
    } catch { /* view-like or transient — leave 0 */ }
    return { name: t.name, columns, rowCount };
  });
}
