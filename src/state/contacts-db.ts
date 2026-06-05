// People-CRM contacts store — structured, exhaustively-queryable records.
//
// This is the deliberate counterpart to Hindsight memory (src/memory/*): where
// recall is associative, ranked, top-K and token-budget-capped, the contacts
// store answers "find ALL people where company = X" with a plain SQL WHERE that
// returns every matching row (cursor-paginated, never reranked). See ADR
// people-crm-store.md for why the CRM use case needs this separate access
// pattern rather than an extension of the memory store.
//
// Rows are scoped by agent_id (the per-agent memory namespace) so each agent
// owns its own network, mirroring Hindsight's per-agent isolation. DDL lives in
// memory-db.ts applyMigrations (schema version 10); this module owns the row
// helpers, matching the chat-blocks.ts split.

import type { Instance } from "../types";
import { getMemoryDb } from "./memory-db";
import { id, now } from "./ids";

export interface Contact {
  id: string;
  agentId: string | null;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  location: string | null;
  email: string | null;
  linkedinUrl: string | null;
  connectedAt: string | null;
  source: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// Fields a caller may supply on insert/update. Undefined means "leave alone" on
// update; null/"" means "clear". fullName is required on insert and derived
// from first/last when omitted.
export interface ContactInput {
  fullName?: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  location?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  connectedAt?: string | null;
  source?: string;
  notes?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ContactQuery {
  company?: string;          // exact, case-insensitive
  companyContains?: string;  // substring
  title?: string;            // substring
  location?: string;         // substring
  nameContains?: string;     // substring on full name
  emailContains?: string;    // substring on email
  q?: string;                // substring across full_name + company + title
  connectedAfter?: string;   // ISO date; connected_at >= this
  connectedBefore?: string;  // ISO date; connected_at <= this
  hasCompany?: boolean;      // true → company set & non-empty; false → blank
  ids?: string[];
  limit?: number;            // default 500, max 2000
  offset?: number;
}

export interface ContactRelation {
  agentId: string | null;
  fromContactId: string;
  toContactId: string;
  relationType: string;
  note: string | null;
  source: string | null;
  createdAt: string;
}

interface ContactRow {
  id: string;
  agent_id: string | null;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  title: string | null;
  location: string | null;
  email: string | null;
  linkedin_url: string | null;
  connected_at: string | null;
  source: string;
  notes: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

const DEFAULT_QUERY_LIMIT = 500;
const MAX_QUERY_LIMIT = 2000;

function rowToContact(row: ContactRow): Contact {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metadata || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
  } catch {
    /* tolerate a malformed metadata blob — treat as empty */
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    fullName: row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
    company: row.company,
    title: row.title,
    location: row.location,
    email: row.email,
    linkedinUrl: row.linkedin_url,
    connectedAt: row.connected_at,
    source: row.source,
    notes: row.notes,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Normalize a free-text field to a trimmed string or null. Empty/whitespace
// collapses to null so blank LinkedIn cells don't create "" rows that defeat
// the hasCompany filter and the linkedin_url UNIQUE partial index.
function clean(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Escape LIKE wildcards in user-supplied substrings so a literal % or _ in a
// company name matches literally. Pairs with ESCAPE '\' in the SQL.
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function deriveFullName(input: ContactInput): string {
  const explicit = clean(input.fullName);
  if (explicit) return explicit;
  const parts = [clean(input.firstName), clean(input.lastName)].filter(Boolean);
  return parts.join(" ").trim();
}

export function getContact(instance: Instance, agentId: string, contactId: string): Contact | null {
  const db = getMemoryDb(instance);
  const row = db
    .query<ContactRow, [string, string]>("SELECT * FROM contacts WHERE id = ? AND agent_id = ?")
    .get(contactId, agentId);
  return row ? rowToContact(row) : null;
}

export function findContactByUrl(instance: Instance, agentId: string, linkedinUrl: string): Contact | null {
  const url = clean(linkedinUrl);
  if (!url) return null;
  const db = getMemoryDb(instance);
  const row = db
    .query<ContactRow, [string, string]>(
      "SELECT * FROM contacts WHERE agent_id = ? AND linkedin_url = ? COLLATE NOCASE LIMIT 1"
    )
    .get(agentId, url);
  return row ? rowToContact(row) : null;
}

export function findContactByEmail(instance: Instance, agentId: string, email: string): Contact | null {
  const value = clean(email);
  if (!value) return null;
  const db = getMemoryDb(instance);
  const row = db
    .query<ContactRow, [string, string]>(
      "SELECT * FROM contacts WHERE agent_id = ? AND email = ? COLLATE NOCASE LIMIT 1"
    )
    .get(agentId, value);
  return row ? rowToContact(row) : null;
}

export function findContactsByName(instance: Instance, agentId: string, fullName: string): Contact[] {
  const value = clean(fullName);
  if (!value) return [];
  const db = getMemoryDb(instance);
  return db
    .query<ContactRow, [string, string]>(
      "SELECT * FROM contacts WHERE agent_id = ? AND full_name = ? COLLATE NOCASE ORDER BY updated_at DESC"
    )
    .all(agentId, value)
    .map(rowToContact);
}

export function insertContact(instance: Instance, agentId: string, input: ContactInput): Contact {
  const fullName = deriveFullName(input);
  if (!fullName) throw new Error("Cannot create a contact without a name.");
  const db = getMemoryDb(instance);
  const at = now();
  const contact: Contact = {
    id: id("contact"),
    agentId,
    fullName,
    firstName: clean(input.firstName),
    lastName: clean(input.lastName),
    company: clean(input.company),
    title: clean(input.title),
    location: clean(input.location),
    email: clean(input.email),
    linkedinUrl: clean(input.linkedinUrl),
    connectedAt: clean(input.connectedAt),
    source: clean(input.source) ?? "manual",
    notes: clean(input.notes),
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
    createdAt: at,
    updatedAt: at
  };
  db.run(
    `INSERT INTO contacts (
       id, agent_id, full_name, first_name, last_name, company, title, location,
       email, linkedin_url, connected_at, source, notes, metadata, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      contact.id, contact.agentId, contact.fullName, contact.firstName, contact.lastName,
      contact.company, contact.title, contact.location, contact.email, contact.linkedinUrl,
      contact.connectedAt, contact.source, contact.notes, JSON.stringify(contact.metadata),
      contact.createdAt, contact.updatedAt
    ]
  );
  return contact;
}

// Merge-update: only fields PRESENT in `patch` (key defined) are written.
// A null/empty value clears the column; an omitted key leaves it untouched.
// metadata is shallow-merged. Returns the updated contact.
export function updateContact(
  instance: Instance,
  agentId: string,
  contactId: string,
  patch: ContactInput
): Contact {
  const existing = getContact(instance, agentId, contactId);
  if (!existing) throw new Error(`Contact not found: ${contactId}`);
  const sets: string[] = [];
  const params: (string | null)[] = [];
  const assign = (column: string, value: string | null) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if ("fullName" in patch || "firstName" in patch || "lastName" in patch) {
    if ("firstName" in patch) assign("first_name", clean(patch.firstName));
    if ("lastName" in patch) assign("last_name", clean(patch.lastName));
    // Recompute full name from the merged first/last unless an explicit
    // fullName was given.
    const explicit = clean(patch.fullName);
    if (explicit) {
      assign("full_name", explicit);
    } else if ("firstName" in patch || "lastName" in patch) {
      const first = "firstName" in patch ? clean(patch.firstName) : existing.firstName;
      const last = "lastName" in patch ? clean(patch.lastName) : existing.lastName;
      const derived = [first, last].filter(Boolean).join(" ").trim();
      if (derived) assign("full_name", derived);
    }
  }
  if ("company" in patch) assign("company", clean(patch.company));
  if ("title" in patch) assign("title", clean(patch.title));
  if ("location" in patch) assign("location", clean(patch.location));
  if ("email" in patch) assign("email", clean(patch.email));
  if ("linkedinUrl" in patch) assign("linkedin_url", clean(patch.linkedinUrl));
  if ("connectedAt" in patch) assign("connected_at", clean(patch.connectedAt));
  if ("source" in patch) assign("source", clean(patch.source) ?? existing.source);
  if ("notes" in patch) assign("notes", clean(patch.notes));
  if (patch.metadata && typeof patch.metadata === "object") {
    const merged = { ...existing.metadata, ...patch.metadata };
    assign("metadata", JSON.stringify(merged));
  }
  const at = now();
  sets.push("updated_at = ?");
  params.push(at);
  params.push(contactId, agentId);
  const db = getMemoryDb(instance);
  db.run(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ? AND agent_id = ?`, params);
  return getContact(instance, agentId, contactId)!;
}

// Import-path upsert: dedup on the stable keys in order (linkedin_url, then
// email), inserting when none match. On a match, fields present in `input`
// overwrite when non-empty; existing values are preserved for keys the import
// row leaves blank (so re-importing a sparser export never wipes enrichment).
export function upsertContactByKey(
  instance: Instance,
  agentId: string,
  input: ContactInput
): { contact: Contact; created: boolean } {
  const existing =
    findContactByUrl(instance, agentId, input.linkedinUrl ?? "") ??
    findContactByEmail(instance, agentId, input.email ?? "");
  if (!existing) {
    return { contact: insertContact(instance, agentId, input), created: true };
  }
  // Only carry forward non-empty incoming fields so a blank cell can't clear
  // an existing value. Build a patch of just the keys that have content.
  const patch: ContactInput = {};
  const carry = (key: keyof ContactInput) => {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) (patch as Record<string, unknown>)[key] = value;
  };
  carry("fullName");
  carry("firstName");
  carry("lastName");
  carry("company");
  carry("title");
  carry("location");
  carry("email");
  carry("linkedinUrl");
  carry("connectedAt");
  carry("notes");
  if (input.metadata && Object.keys(input.metadata).length > 0) patch.metadata = input.metadata;
  const contact = Object.keys(patch).length > 0
    ? updateContact(instance, agentId, existing.id, patch)
    : existing;
  return { contact, created: false };
}

function buildWhere(agentId: string, query: ContactQuery): { sql: string; params: (string | number)[] } {
  const where: string[] = ["agent_id = ?"];
  const params: (string | number)[] = [agentId];
  if (query.company) {
    where.push("company = ? COLLATE NOCASE");
    params.push(query.company.trim());
  }
  if (query.companyContains) {
    where.push("company LIKE ? ESCAPE '\\' COLLATE NOCASE");
    params.push(likeContains(query.companyContains.trim()));
  }
  if (query.title) {
    where.push("title LIKE ? ESCAPE '\\' COLLATE NOCASE");
    params.push(likeContains(query.title.trim()));
  }
  if (query.location) {
    where.push("location LIKE ? ESCAPE '\\' COLLATE NOCASE");
    params.push(likeContains(query.location.trim()));
  }
  if (query.nameContains) {
    where.push("full_name LIKE ? ESCAPE '\\' COLLATE NOCASE");
    params.push(likeContains(query.nameContains.trim()));
  }
  if (query.emailContains) {
    where.push("email LIKE ? ESCAPE '\\' COLLATE NOCASE");
    params.push(likeContains(query.emailContains.trim()));
  }
  if (query.q) {
    const term = likeContains(query.q.trim());
    where.push(
      "(full_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR company LIKE ? ESCAPE '\\' COLLATE NOCASE OR title LIKE ? ESCAPE '\\' COLLATE NOCASE)"
    );
    params.push(term, term, term);
  }
  if (query.connectedAfter) {
    where.push("connected_at >= ?");
    params.push(query.connectedAfter.trim());
  }
  if (query.connectedBefore) {
    where.push("connected_at <= ?");
    params.push(query.connectedBefore.trim());
  }
  if (query.hasCompany === true) {
    where.push("company IS NOT NULL AND company <> ''");
  } else if (query.hasCompany === false) {
    where.push("(company IS NULL OR company = '')");
  }
  if (query.ids && query.ids.length > 0) {
    where.push(`id IN (${query.ids.map(() => "?").join(",")})`);
    params.push(...query.ids);
  }
  return { sql: where.join(" AND "), params };
}

// Exhaustive query: returns EVERY matching contact (capped at `limit`,
// default 500 / max 2000), ordered by name for stable cursor paging. The
// returned `total` lets the caller decide whether to page with `offset`.
// No ranking, no token budget — this is the structured path that makes
// "find all people at X" reliable.
export function queryContacts(
  instance: Instance,
  agentId: string,
  query: ContactQuery = {}
): { contacts: Contact[]; total: number; limit: number; offset: number; hasMore: boolean } {
  const db = getMemoryDb(instance);
  const { sql, params } = buildWhere(agentId, query);
  const total = countContacts(instance, agentId, query);
  const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_QUERY_LIMIT)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const rows = db
    .query<ContactRow, (string | number)[]>(
      `SELECT * FROM contacts WHERE ${sql} ORDER BY full_name COLLATE NOCASE, id LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  return {
    contacts: rows.map(rowToContact),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total
  };
}

export function countContacts(instance: Instance, agentId: string, query: ContactQuery = {}): number {
  const db = getMemoryDb(instance);
  const { sql, params } = buildWhere(agentId, query);
  const row = db
    .query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) AS n FROM contacts WHERE ${sql}`)
    .get(...params);
  return row?.n ?? 0;
}

// Company roster summary: "what companies are in my network, and how many at
// each". Grouped + counted in SQL so the agent can answer aggregate questions
// without pulling every row. Blank companies are excluded.
export function companyBreakdown(
  instance: Instance,
  agentId: string,
  limit = 100
): Array<{ company: string; count: number }> {
  const db = getMemoryDb(instance);
  return db
    .query<{ company: string; count: number }, [string, number]>(
      `SELECT company, COUNT(*) AS count FROM contacts
       WHERE agent_id = ? AND company IS NOT NULL AND company <> ''
       GROUP BY company COLLATE NOCASE
       ORDER BY count DESC, company COLLATE NOCASE
       LIMIT ?`
    )
    .all(agentId, Math.max(1, Math.floor(limit)));
}

export function deleteContact(instance: Instance, agentId: string, contactId: string): boolean {
  const db = getMemoryDb(instance);
  const result = db.run("DELETE FROM contacts WHERE id = ? AND agent_id = ?", [contactId, agentId]);
  return result.changes > 0;
}

export function countAllContacts(instance: Instance, agentId: string): number {
  return countContacts(instance, agentId, {});
}

// ---- Relationships (person ↔ person edges) ----

export function upsertRelation(
  instance: Instance,
  agentId: string,
  fromContactId: string,
  toContactId: string,
  relationType: string,
  note?: string | null,
  source?: string | null
): ContactRelation {
  if (fromContactId === toContactId) throw new Error("A contact cannot have a relationship with itself.");
  const db = getMemoryDb(instance);
  const type = clean(relationType) ?? "knows";
  const at = now();
  db.run(
    `INSERT INTO contact_relations (agent_id, from_contact_id, to_contact_id, relation_type, note, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(from_contact_id, to_contact_id, relation_type)
     DO UPDATE SET note = excluded.note, source = excluded.source`,
    [agentId, fromContactId, toContactId, type, clean(note ?? null), clean(source ?? null), at]
  );
  return {
    agentId,
    fromContactId,
    toContactId,
    relationType: type,
    note: clean(note ?? null),
    source: clean(source ?? null),
    createdAt: at
  };
}

interface RelationRow {
  agent_id: string | null;
  from_contact_id: string;
  to_contact_id: string;
  relation_type: string;
  note: string | null;
  source: string | null;
  created_at: string;
}

function rowToRelation(row: RelationRow): ContactRelation {
  return {
    agentId: row.agent_id,
    fromContactId: row.from_contact_id,
    toContactId: row.to_contact_id,
    relationType: row.relation_type,
    note: row.note,
    source: row.source,
    createdAt: row.created_at
  };
}

// Every edge touching `contactId`, in either direction.
export function relationsFor(instance: Instance, agentId: string, contactId: string): ContactRelation[] {
  const db = getMemoryDb(instance);
  return db
    .query<RelationRow, [string, string, string]>(
      `SELECT * FROM contact_relations
       WHERE agent_id = ? AND (from_contact_id = ? OR to_contact_id = ?)
       ORDER BY created_at`
    )
    .all(agentId, contactId, contactId)
    .map(rowToRelation);
}

// Contacts that both A and B have an edge to (in either direction): the
// "people you both know" relationship-graph query. Treats edges as undirected.
export function mutualConnections(
  instance: Instance,
  agentId: string,
  contactIdA: string,
  contactIdB: string
): Contact[] {
  const neighbors = (contactId: string): Set<string> => {
    const set = new Set<string>();
    for (const rel of relationsFor(instance, agentId, contactId)) {
      set.add(rel.fromContactId === contactId ? rel.toContactId : rel.fromContactId);
    }
    return set;
  };
  const a = neighbors(contactIdA);
  const b = neighbors(contactIdB);
  const shared = [...a].filter((cid) => b.has(cid) && cid !== contactIdA && cid !== contactIdB);
  return shared
    .map((cid) => getContact(instance, agentId, cid))
    .filter((c): c is Contact => c !== null);
}
