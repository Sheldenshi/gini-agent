// Deterministic contact importer: one input row → one upserted contact.
//
// This bypasses the lossy path entirely. The chat-attachment flow inlines a
// CSV as capped text and lets the model summarize it (so thousands of rows get
// truncated and people get dropped); this importer instead reads the file from
// disk and upserts each row structurally, with an exact created/updated/skipped
// report. LinkedIn's export carries a few preamble "Notes:" lines before the
// real header, so the column detector finds the header row rather than assuming
// row 0.

import type { Instance } from "../types";
import { upsertContactByKey, countAllContacts, companyBreakdown, type ContactInput } from "../state/contacts-db";

export interface ImportReport {
  total: number; // data rows considered (excludes preamble + header)
  created: number;
  updated: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  detectedColumns: string[];
  companies: Array<{ company: string; count: number }>;
  contactsTotal: number; // total contacts for this agent after the import
  sample: string[]; // a few imported names, for the agent to echo back
}

type FieldKey =
  | "firstName"
  | "lastName"
  | "fullName"
  | "company"
  | "title"
  | "location"
  | "email"
  | "linkedinUrl"
  | "connectedAt";

// Header synonyms, lower-cased. First match wins per column.
const HEADER_SYNONYMS: Record<FieldKey, string[]> = {
  firstName: ["first name", "firstname", "given name"],
  lastName: ["last name", "lastname", "surname", "family name"],
  fullName: ["full name", "name", "contact name"],
  company: ["company", "organization", "organisation", "current company", "company name", "employer"],
  title: ["position", "title", "job title", "role", "headline"],
  location: ["location", "city", "region", "country", "area"],
  email: ["email address", "email", "e-mail", "emails", "email addresses"],
  linkedinUrl: ["url", "profile url", "linkedin url", "public profile url", "profile", "linkedin"],
  connectedAt: ["connected on", "connected", "connection date", "date connected", "connected at"]
};

// Quote-aware CSV tokenizer. Handles RFC-4180 quoting ("" escapes a quote
// inside a quoted field), embedded commas/newlines, and CRLF or LF line
// endings. Returns an array of rows, each an array of cell strings.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { pushField(); i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { pushRow(); i++; continue; }
    field += ch; i++;
  }
  // Flush the trailing field/row unless the file ended on a clean newline.
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

interface ColumnMap {
  headerIndex: number;
  columns: Partial<Record<FieldKey, number>>;
}

function matchHeader(cell: string): FieldKey | null {
  const norm = cell.trim().toLowerCase();
  if (!norm) return null;
  for (const key of Object.keys(HEADER_SYNONYMS) as FieldKey[]) {
    if (HEADER_SYNONYMS[key].includes(norm)) return key;
  }
  return null;
}

// Find the header row (LinkedIn prepends preamble lines) and map its columns to
// fields. A row qualifies as the header when it maps at least two known fields
// AND carries a name column (first/last/full). First qualifying row wins.
export function detectColumns(rows: string[][]): ColumnMap | null {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const cells = rows[r]!;
    const columns: Partial<Record<FieldKey, number>> = {};
    for (let c = 0; c < cells.length; c++) {
      const key = matchHeader(cells[c]!);
      // Keep the first column that claims a field so duplicate-ish headers
      // (e.g. two "email" columns) don't clobber the earlier mapping.
      if (key && columns[key] === undefined) columns[key] = c;
    }
    const mapped = Object.keys(columns).length;
    const hasName =
      columns.firstName !== undefined || columns.lastName !== undefined || columns.fullName !== undefined;
    if (mapped >= 2 && hasName) return { headerIndex: r, columns };
  }
  return null;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
};

// Normalize a "Connected On" value to an ISO date (YYYY-MM-DD) so range
// filters (connectedAfter/Before) compare lexically. Accepts LinkedIn's
// "05 Jun 2024", "Jun 5, 2024", and ISO. Falls back to the trimmed raw value
// when it can't parse — display still works, range compares just won't.
export function parseConnectedOn(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = v.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (dmy) {
    const mon = MONTHS[dmy[2]!.slice(0, 3).toLowerCase()];
    if (mon) return `${dmy[3]}-${mon}-${dmy[1]!.padStart(2, "0")}`;
  }
  const mdy = v.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mdy) {
    const mon = MONTHS[mdy[1]!.slice(0, 3).toLowerCase()];
    if (mon) return `${mdy[3]}-${mon}-${mdy[2]!.padStart(2, "0")}`;
  }
  return v;
}

function cellAt(cells: string[], index: number | undefined): string {
  if (index === undefined) return "";
  return (cells[index] ?? "").trim();
}

// Build a ContactInput from a data row. Returns null when the row has no usable
// name (the only required field) so the caller can count it as skipped.
function rowToInput(cells: string[], map: ColumnMap, source: string): ContactInput | null {
  const first = cellAt(cells, map.columns.firstName);
  const last = cellAt(cells, map.columns.lastName);
  const full = cellAt(cells, map.columns.fullName) || [first, last].filter(Boolean).join(" ").trim();
  if (!full) return null;
  const connectedRaw = cellAt(cells, map.columns.connectedAt);
  return {
    fullName: full,
    firstName: first || null,
    lastName: last || null,
    company: cellAt(cells, map.columns.company) || null,
    title: cellAt(cells, map.columns.title) || null,
    location: cellAt(cells, map.columns.location) || null,
    email: cellAt(cells, map.columns.email) || null,
    linkedinUrl: cellAt(cells, map.columns.linkedinUrl) || null,
    connectedAt: connectedRaw ? parseConnectedOn(connectedRaw) : null,
    source
  };
}

export class ContactImportError extends Error {}

// Parse CSV text and upsert every data row. Throws ContactImportError when no
// header row can be located (so the caller surfaces a clear message instead of
// silently importing zero rows).
export function importContactsFromCsv(
  instance: Instance,
  agentId: string,
  csvText: string,
  source = "linkedin_import"
): ImportReport {
  const rows = parseCsv(csvText);
  const map = detectColumns(rows);
  if (!map) {
    throw new ContactImportError(
      "Could not find a recognizable contact header row (need a name column plus at least one of company/title/email/url)."
    );
  }
  const report: ImportReport = {
    total: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    skippedReasons: {},
    detectedColumns: Object.keys(map.columns),
    companies: [],
    contactsTotal: 0,
    sample: []
  };
  const skip = (reason: string) => {
    report.skipped++;
    report.skippedReasons[reason] = (report.skippedReasons[reason] ?? 0) + 1;
  };
  for (let r = map.headerIndex + 1; r < rows.length; r++) {
    const cells = rows[r]!;
    // Skip fully blank lines (trailing newline, separator rows).
    if (cells.every((c) => c.trim() === "")) continue;
    report.total++;
    const input = rowToInput(cells, map, source);
    if (!input) { skip("no name"); continue; }
    try {
      const { contact, created } = upsertContactByKey(instance, agentId, input);
      if (created) {
        report.created++;
        if (report.sample.length < 8) report.sample.push(contact.fullName);
      } else {
        report.updated++;
      }
    } catch (error) {
      skip(error instanceof Error ? error.message : "upsert failed");
    }
  }
  report.companies = companyBreakdown(instance, agentId, 25);
  report.contactsTotal = countAllContacts(instance, agentId);
  return report;
}
