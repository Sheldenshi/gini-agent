// Generic tabular import for the agent-database primitive: load a CSV or XLSX
// file from the agent's workspace into a table in its per-agent datastore, one
// file row → one table row. This is deliberately domain-agnostic — it derives
// columns from the file's own header row and stores everything as TEXT. Any
// use-case-specific shaping (column renames, type coercion, relationship
// modeling) is the calling skill's job, done with db_execute afterward.
//
// It bypasses the lossy path of asking the model to read a big file inline and
// summarize it: thousands of rows import deterministically without truncation.

import { extname } from "node:path";
import { readFileSync } from "node:fs";
import type { RuntimeConfig } from "../types";
import { assertInsideWorkspaceNoSymlinkEscape } from "../state";
import { getAgentDataDb, AgentDataError } from "../state/agent-data-db";

type XlsxModule = {
  read(data: Uint8Array, opts: { type: "array" }): { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: { sheet_to_csv(sheet: unknown): string };
};
let xlsxPromise: Promise<XlsxModule> | null = null;
function loadXlsx(): Promise<XlsxModule> {
  if (!xlsxPromise) {
    xlsxPromise = import("xlsx").then(
      (m) => (m.default ?? m) as unknown as XlsxModule,
      (err) => { xlsxPromise = null; throw err; }
    );
  }
  return xlsxPromise;
}

export interface ImportTableReport {
  table: string;
  columns: string[];
  rowsInserted: number;
  rowsSkipped: number;
  totalRows: number;
}

// Quote-aware CSV tokenizer (RFC-4180): "" escapes a quote, fields may hold
// commas/newlines, CRLF or LF line endings, tolerant of a missing final newline.
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
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

// Pick the header row. Caller may pin it with skipLines (0-based index of the
// header); otherwise skip leading rows with fewer than two non-empty cells,
// which transparently steps over export preambles (e.g. LinkedIn's "Notes:"
// lines) without any format-specific knowledge.
function detectHeaderRow(rows: string[][], skipLines?: number): number {
  if (skipLines !== undefined && skipLines >= 0) return Math.min(skipLines, Math.max(0, rows.length - 1));
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    if (rows[i]!.filter((c) => c.trim() !== "").length >= 2) return i;
  }
  return 0;
}

// Reduce a header cell to a safe snake_case SQL column name.
function sanitizeColumn(name: string, index: number): string {
  let col = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!col || /^[0-9]/.test(col)) col = `col_${index + 1}${col ? `_${col}` : ""}`;
  return col;
}

function dedupeColumns(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
}

function sanitizeTable(name: string): string {
  const safe = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe || /^[0-9]/.test(safe)) throw new AgentDataError(`Invalid table name: ${name}`);
  return safe;
}

function readFileAsCsv(absPath: string): Promise<string> | string {
  const ext = extname(absPath).toLowerCase();
  if (ext === ".xlsx" || ext === ".xls") {
    return loadXlsx().then((xlsx) => {
      const wb = xlsx.read(new Uint8Array(readFileSync(absPath)), { type: "array" });
      const sheet = wb.SheetNames[0];
      if (!sheet) throw new AgentDataError("Spreadsheet has no sheets to import.");
      return xlsx.utils.sheet_to_csv(wb.Sheets[sheet]);
    });
  }
  return readFileSync(absPath, "utf8");
}

export async function importTableFromFile(
  config: RuntimeConfig,
  agentId: string,
  workspacePath: string,
  tableName: string,
  opts: { skipLines?: number; recreate?: boolean } = {}
): Promise<ImportTableReport> {
  const abs = assertInsideWorkspaceNoSymlinkEscape(config.workspaceRoot, workspacePath);
  const table = sanitizeTable(tableName);
  const csv = await readFileAsCsv(abs);
  const rows = parseCsv(csv);
  if (rows.length === 0) throw new AgentDataError("The file is empty.");

  const headerIndex = detectHeaderRow(rows, opts.skipLines);
  const header = rows[headerIndex]!;
  if (header.filter((c) => c.trim() !== "").length === 0) {
    throw new AgentDataError("Could not find a header row in the file.");
  }
  const columns = dedupeColumns(header.map((cell, idx) => sanitizeColumn(cell, idx)));

  const db = getAgentDataDb(config.instance, agentId);
  const quotedTable = `"${table}"`;
  const quotedCols = columns.map((c) => `"${c}"`).join(", ");

  const report: ImportTableReport = { table, columns, rowsInserted: 0, rowsSkipped: 0, totalRows: 0 };

  const tx = db.transaction(() => {
    if (opts.recreate) db.run(`DROP TABLE IF EXISTS ${quotedTable}`);
    db.run(`CREATE TABLE IF NOT EXISTS ${quotedTable} (${columns.map((c) => `"${c}" TEXT`).join(", ")})`);
    const placeholders = columns.map(() => "?").join(", ");
    const insert = db.prepare(`INSERT INTO ${quotedTable} (${quotedCols}) VALUES (${placeholders})`);
    for (let r = headerIndex + 1; r < rows.length; r++) {
      const cells = rows[r]!;
      if (cells.every((c) => c.trim() === "")) continue; // blank line
      report.totalRows++;
      // Align cells to columns: pad short rows with null, drop overflow. Empty
      // cells become NULL so filters/joins behave (vs. matching "").
      const values = columns.map((_, idx) => {
        const v = cells[idx];
        return v !== undefined && v.trim() !== "" ? v : null;
      });
      try {
        insert.run(...(values as never[]));
        report.rowsInserted++;
      } catch {
        report.rowsSkipped++;
      }
    }
  });
  tx();
  return report;
}
