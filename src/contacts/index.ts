// People-CRM module. The bounded runtime surface for managing a network of
// contacts (the LinkedIn-import use case) — deterministic import plus the
// exhaustive structured query/relate operations the agent tools, /api/contacts
// routes, and `gini contacts` CLI all delegate to. Storage primitives live in
// src/state/contacts-db.ts; this module owns file-level orchestration (reading
// the uploaded CSV/XLSX from the workspace) and re-exports the storage surface
// so callers import from one place.

import { extname } from "node:path";
import { readFileSync } from "node:fs";
import type { RuntimeConfig } from "../types";
import { assertInsideWorkspaceNoSymlinkEscape } from "../state";
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

export {
  ContactImportError,
  importContactsFromCsv,
  parseCsv,
  detectColumns,
  parseConnectedOn,
  type ImportReport
} from "./import";
