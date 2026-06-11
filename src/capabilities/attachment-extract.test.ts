import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFormat, extractText } from "./attachment-extract";

const FIXTURES = join(import.meta.dir, "__fixtures__");

describe("classifyFormat", () => {
  test("text by extension", () => {
    expect(classifyFormat("application/octet-stream", "data.csv")).toBe("text");
    expect(classifyFormat("", "notes.md")).toBe("text");
    expect(classifyFormat("", "script.py")).toBe("text");
  });

  test("text by mime", () => {
    expect(classifyFormat("text/plain", "noext")).toBe("text");
    expect(classifyFormat("application/json", "noext")).toBe("text");
    expect(classifyFormat("application/x-yaml", "noext")).toBe("text");
  });

  test("pdf", () => {
    expect(classifyFormat("application/pdf", "report.pdf")).toBe("pdf");
    expect(classifyFormat("application/octet-stream", "report.pdf")).toBe("pdf");
  });

  test("docx", () => {
    expect(
      classifyFormat(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc.docx"
      )
    ).toBe("docx");
    expect(classifyFormat("application/octet-stream", "doc.docx")).toBe("docx");
  });

  test("xlsx and xls", () => {
    expect(
      classifyFormat(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "book.xlsx"
      )
    ).toBe("xlsx");
    expect(classifyFormat("application/octet-stream", "book.xlsx")).toBe("xlsx");
    expect(classifyFormat("application/octet-stream", "book.xls")).toBe("xlsx");
  });

  test("unsupported", () => {
    expect(classifyFormat("application/zip", "archive.zip")).toBe("unsupported");
    expect(classifyFormat("application/octet-stream", "blob.bin")).toBe("unsupported");
  });
});

describe("extractText", () => {
  test("text round-trips through utf-8 decode", async () => {
    const source = "line one\nline two — café 🚀";
    const bytes = new TextEncoder().encode(source);
    const result = await extractText(bytes, "text/plain", "notes.txt");
    expect(result).not.toBeNull();
    expect(result!.text).toBe(source);
    expect(result!.truncated).toBe(false);
  });

  test("pdf fixture yields its text layer", async () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, "sample.pdf")));
    const result = await extractText(bytes, "application/pdf", "sample.pdf");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Hello Gini PDF fixture");
  });

  test("pdf bytes as a Node Buffer extract (pdfjs rejects Uint8Array subclasses)", async () => {
    const bytes = readFileSync(join(FIXTURES, "sample.pdf")); // Buffer
    const result = await extractText(bytes, "application/pdf", "sample.pdf");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Hello Gini PDF fixture");
  });

  test("docx fixture yields its raw text", async () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, "sample.docx")));
    const result = await extractText(
      bytes,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "sample.docx"
    );
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Hello Gini DOCX fixture");
  });

  test("xlsx built in-test yields its cell values as csv", async () => {
    const xlsx = await import("xlsx");
    const sheet = xlsx.utils.aoa_to_sheet([
      ["name", "score"],
      ["alice", 42]
    ]);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, sheet, "Results");
    const out = xlsx.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;

    const result = await extractText(
      new Uint8Array(out),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "book.xlsx"
    );
    expect(result).not.toBeNull();
    expect(result!.text).toContain("# Results");
    expect(result!.text).toContain("alice");
    expect(result!.text).toContain("42");
  });

  test("unsupported format returns null", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const result = await extractText(bytes, "application/zip", "archive.zip");
    expect(result).toBeNull();
  });

  test("malformed pdf returns null instead of throwing", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 not actually a pdf");
    const result = await extractText(bytes, "application/pdf", "broken.pdf");
    expect(result).toBeNull();
  });
});
