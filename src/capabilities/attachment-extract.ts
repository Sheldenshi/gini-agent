// Text extraction for user-uploaded non-image attachments. The chat path
// uses this to inline a text preview of a file when the active provider can't
// take the file natively (no nativeDocs). Extraction is best-effort: any
// load-or-parse failure returns null so the caller falls back to a path-only
// reference rather than crashing the turn.
//
// Heavy parsers (pdfjs-dist, mammoth, xlsx) are pulled in via lazy cached
// dynamic import so they never load unless a matching file actually arrives.

export type AttachmentFormat = "text" | "pdf" | "docx" | "xlsx" | "unsupported";

export interface ExtractedText {
  text: string;
  // The 256KB inline cap is applied by the chat caller, not here, so this is
  // always false today. Kept so the caller's shape doesn't have to change when
  // it decides whether to note truncation.
  truncated: boolean;
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Extensions that round-trip cleanly through a UTF-8 decode: plain-text data
// formats plus common source-code files.
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html",
  "htm", "log",
  // common code
  "js", "ts", "tsx", "jsx", "py", "sh", "go", "rs", "java", "c", "cpp", "h",
  "css", "sql"
]);

const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml"
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

// Classify a file into one of the extractable buckets (or "unsupported") from
// its MIME type and filename. Allowlist-only: anything not explicitly matched
// is "unsupported" so the caller path-references it instead of guessing.
export function classifyFormat(mime: string, filename: string): AttachmentFormat {
  const m = mime.toLowerCase();
  const ext = extensionOf(filename);

  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m === DOCX_MIME || ext === "docx") return "docx";
  if (m === XLSX_MIME || ext === "xlsx" || ext === "xls") return "xlsx";

  if (m.startsWith("text/") || TEXT_MIMES.has(m) || TEXT_EXTENSIONS.has(ext)) {
    return "text";
  }

  return "unsupported";
}

// Minimal structural typings for the lazily-imported parsers. We only touch
// the few members we use; full types would pull the libs into the build graph.
type PdfjsModule = {
  getDocument(args: { data: Uint8Array; disableWorker?: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
      }>;
    }>;
  };
};
type MammothModule = {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
};
type XlsxModule = {
  read(data: Uint8Array, opts: { type: "array" }): {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: { sheet_to_csv(sheet: unknown): string };
};

// Lazy cached dynamic imports. On a rejected import the cached promise is
// nulled so a later call retries (e.g. a transient resolution failure) rather
// than being stuck on a permanently rejected promise.
let pdfjsPromise: Promise<PdfjsModule> | null = null;
let mammothPromise: Promise<MammothModule> | null = null;
let xlsxPromise: Promise<XlsxModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then(
      (m) => m as unknown as PdfjsModule,
      (err) => {
        pdfjsPromise = null;
        throw err;
      }
    );
  }
  return pdfjsPromise;
}

function loadMammoth(): Promise<MammothModule> {
  if (!mammothPromise) {
    mammothPromise = import("mammoth").then(
      (m) => (m.default ?? m) as unknown as MammothModule,
      (err) => {
        mammothPromise = null;
        throw err;
      }
    );
  }
  return mammothPromise;
}

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

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await loadPdfjs();
  // Text layer only in v1. A scanned-PDF page-image render fallback would slot
  // in here, returning `{ text, images }` to the caller — see the delivery
  // design's deferred render note.
  const doc = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => item.str ?? "")
      .filter((s) => s.length > 0)
      .join(" ");
    pages.push(line);
  }
  return pages.join("\n\n");
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await loadMammoth();
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return value;
}

async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const xlsx = await loadXlsx();
  const wb = xlsx.read(bytes, { type: "array" });
  const sheets = wb.SheetNames.map((name) => {
    const csv = xlsx.utils.sheet_to_csv(wb.Sheets[name]);
    return `# ${name}\n${csv}`;
  });
  return sheets.join("\n\n");
}

// Extract a UTF-8 text preview from an attachment's bytes. Returns null for
// unsupported formats and for any load-or-parse failure (the caller then
// path-references the file). Never throws.
export async function extractText(
  bytes: Uint8Array,
  mime: string,
  filename: string
): Promise<ExtractedText | null> {
  const format = classifyFormat(mime, filename);
  if (format === "unsupported") return null;

  try {
    let text: string;
    switch (format) {
      case "text":
        text = new TextDecoder("utf-8").decode(bytes);
        break;
      case "pdf":
        text = await extractPdf(bytes);
        break;
      case "docx":
        text = await extractDocx(bytes);
        break;
      case "xlsx":
        text = await extractXlsx(bytes);
        break;
    }
    return { text, truncated: false };
  } catch (err) {
    console.debug(
      `attachment-extract: ${format} extraction failed for ${filename}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}
