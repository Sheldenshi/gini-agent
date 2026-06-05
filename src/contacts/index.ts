// People-CRM module. The bounded runtime surface for managing a network of
// contacts (the LinkedIn-import use case) — deterministic import plus the
// exhaustive structured query/relate operations the agent tools, /api/contacts
// routes, and `gini contacts` CLI all delegate to. Storage primitives live in
// src/state/contacts-db.ts; this module owns file-level orchestration (reading
// the uploaded CSV/XLSX from the workspace) and re-exports the storage surface
// so callers import from one place.

import { extname } from "node:path";
import { readFileSync } from "node:fs";
import type { RuntimeConfig, Instance } from "../types";
import {
  assertInsideWorkspaceNoSymlinkEscape,
  findContactByEmail,
  findContactByUrl,
  findContactsByName,
  getContact,
  insertContact,
  relationsFor,
  updateContact,
  upsertRelation,
  type Contact,
  type ContactInput,
  type ContactQuery
} from "../state";
import { ContactImportError, importContactsFromCsv, type ImportReport } from "./import";

type XlsxModule = {
  read(data: Uint8Array, opts: { type: "array" }): {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: { sheet_to_csv(sheet: unknown): string };
};

let xlsxPromise: Promise<XlsxModule> | null = null;
function loadXlsx(): Promise<XlsxModule> {
  if (!xlsxPromise) {
    xlsxPromise = import("xlsx").then(
      (m) => (m.default ?? m) as unknown as XlsxModule,
      (err) => {
        xlsxPromise = null;
        throw err;
      }
    );
  }
  return xlsxPromise;
}

// Import a contacts file that lives in the agent's workspace (where chat
// attachments are materialized). CSV is read directly; XLSX/XLS is converted to
// CSV via the existing `xlsx` dependency, then run through the same row-level
// importer. The workspace-escape guard rejects a path that resolves outside the
// workspace (including via symlink).
export async function importContactsFromFile(
  config: RuntimeConfig,
  agentId: string,
  workspacePath: string,
  source = "linkedin_import"
): Promise<ImportReport> {
  const abs = assertInsideWorkspaceNoSymlinkEscape(config.workspaceRoot, workspacePath);
  const ext = extname(abs).toLowerCase();
  let csvText: string;
  if (ext === ".xlsx" || ext === ".xls") {
    const xlsx = await loadXlsx();
    const bytes = new Uint8Array(readFileSync(abs));
    const wb = xlsx.read(bytes, { type: "array" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new ContactImportError("Spreadsheet has no sheets to import.");
    csvText = xlsx.utils.sheet_to_csv(wb.Sheets[sheetName]);
  } else {
    csvText = readFileSync(abs, "utf8");
  }
  return importContactsFromCsv(config.instance, agentId, csvText, source);
}

// ---- Shared operations (used by both the agent tools and the /api/contacts
// routes, so the URL-first dedup and name-ambiguity rules live in one place) ----

// Build a ContactQuery from generic field getters, so the tool (args object),
// the API (URLSearchParams), and any future caller share one filter surface
// and field list instead of re-deriving it three times.
export function buildContactQuery(
  getStr: (key: string) => string | undefined,
  getBool: (key: string) => boolean | undefined,
  getNum: (key: string) => number | undefined
): ContactQuery {
  const query: ContactQuery = {};
  for (const key of ["company", "companyContains", "title", "location", "nameContains", "emailContains", "q", "connectedAfter", "connectedBefore"] as const) {
    const value = getStr(key);
    if (value) (query as Record<string, unknown>)[key] = value;
  }
  const hasCompany = getBool("hasCompany");
  if (hasCompany !== undefined) query.hasCompany = hasCompany;
  const limit = getNum("limit");
  if (limit !== undefined) query.limit = limit;
  const offset = getNum("offset");
  if (offset !== undefined) query.offset = offset;
  return query;
}

export type ContactRef = string; // a contact id (contact_…) or a name.

export type RefResolution =
  | { contact: Contact }
  | { candidates: Contact[] }
  | { none: true };

// Resolve a reference that may be a contact id or a name. An id (contact_…)
// looks up directly; a name returns the single match, the candidate set when
// ambiguous, or none.
export function resolveContactRef(instance: Instance, agentId: string, ref: string): RefResolution {
  const trimmed = ref.trim();
  if (trimmed.startsWith("contact_")) {
    const contact = getContact(instance, agentId, trimmed);
    return contact ? { contact } : { none: true };
  }
  const matches = findContactsByName(instance, agentId, trimmed);
  if (matches.length === 1) return { contact: matches[0]! };
  if (matches.length > 1) return { candidates: matches };
  return { none: true };
}

export type UpsertResult =
  | { action: "created" | "updated"; contact: Contact }
  | { action: "ambiguous"; name: string; candidates: Contact[] };

// Create or update one contact. Resolution order:
//   id (when given) → linkedin_url → email → name.
// A supplied LinkedIn URL is treated as a stable unique identity: a miss means
// a new person, NOT a name-merge (two distinct profiles can share a name).
export function upsertContact(
  instance: Instance,
  agentId: string,
  input: ContactInput & { id?: string },
  source = "chat"
): UpsertResult {
  const { id: explicitId, ...patch } = input;
  if (explicitId) {
    const existing = getContact(instance, agentId, explicitId);
    if (!existing) throw new Error(`Contact not found: ${explicitId}`);
    return { action: "updated", contact: updateContact(instance, agentId, explicitId, patch) };
  }
  const name = (patch.fullName ?? [patch.firstName, patch.lastName].filter(Boolean).join(" ")).trim();
  const create = (): UpsertResult => {
    if (!name) throw new Error("Provide a fullName (or firstName/lastName) to create a contact.");
    return { action: "created", contact: insertContact(instance, agentId, { ...patch, fullName: name, source }) };
  };
  const url = patch.linkedinUrl?.trim();
  if (url) {
    const byUrl = findContactByUrl(instance, agentId, url);
    return byUrl ? { action: "updated", contact: updateContact(instance, agentId, byUrl.id, patch) } : create();
  }
  const email = patch.email?.trim();
  if (email) {
    const byEmail = findContactByEmail(instance, agentId, email);
    if (byEmail) return { action: "updated", contact: updateContact(instance, agentId, byEmail.id, patch) };
  }
  if (name) {
    const matches = findContactsByName(instance, agentId, name);
    if (matches.length === 1) return { action: "updated", contact: updateContact(instance, agentId, matches[0]!.id, patch) };
    if (matches.length > 1) return { action: "ambiguous", name, candidates: matches };
  }
  return create();
}

export type RelateResult =
  | { ok: true; from: Contact; to: Contact; relationType: string }
  | { ok: false; reason: "unresolved" | "self"; role?: string; ref?: string; candidates?: Contact[] };

// Record a person↔person edge, resolving each endpoint by ref.
export function relateContacts(
  instance: Instance,
  agentId: string,
  fromRef: string,
  toRef: string,
  relationType = "knows",
  note?: string | null,
  source = "chat"
): RelateResult {
  const resolveEnd = (ref: string, role: string): { contact: Contact } | { ok: false; reason: "unresolved"; role: string; ref: string; candidates?: Contact[] } => {
    const r = resolveContactRef(instance, agentId, ref);
    if ("contact" in r) return { contact: r.contact };
    return { ok: false, reason: "unresolved", role, ref, candidates: "candidates" in r ? r.candidates : undefined };
  };
  const from = resolveEnd(fromRef, "from");
  if ("ok" in from) return from;
  const to = resolveEnd(toRef, "to");
  if ("ok" in to) return to;
  if (from.contact.id === to.contact.id) return { ok: false, reason: "self" };
  upsertRelation(instance, agentId, from.contact.id, to.contact.id, relationType, note ?? null, source);
  return { ok: true, from: from.contact, to: to.contact, relationType: relationType || "knows" };
}

export interface RelationView {
  relationType: string;
  note: string | null;
  contact: Contact | null;
}

// The edges of one contact, each resolved to the other endpoint's record.
export function relationViews(instance: Instance, agentId: string, contactId: string): RelationView[] {
  return relationsFor(instance, agentId, contactId).map((rel) => {
    const otherId = rel.fromContactId === contactId ? rel.toContactId : rel.fromContactId;
    return { relationType: rel.relationType, note: rel.note, contact: getContact(instance, agentId, otherId) };
  });
}

export {
  ContactImportError,
  importContactsFromCsv,
  parseCsv,
  detectColumns,
  parseConnectedOn,
  type ImportReport
} from "./import";
