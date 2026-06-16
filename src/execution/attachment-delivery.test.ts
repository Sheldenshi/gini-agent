// Unit tests for capability-driven attachment delivery.
//
// buildAttachmentContent turns a turn's uploads into provider content parts:
// images stay image_url; non-image files are materialized to the workspace and
// then delivered by capability — native `document` part (PDF on a nativeDocs
// provider), inlined extracted text (boundary-wrapped, capped at 256KB), or a
// path-only note for unsupported formats / extraction failures / replay turns.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeUpload } from "../state/uploads";
import type { MessageContentPart } from "../provider";
import type { ProviderModality } from "../provider-capabilities";
import type { RuntimeConfig } from "../types";
import { buildAttachmentContent } from "./chat-task";

const FIXTURES = join(import.meta.dir, "..", "capabilities", "__fixtures__");
const NATIVE: ProviderModality = { vision: true, nativeDocs: true };
const TEXT_ONLY: ProviderModality = { vision: false, nativeDocs: false };

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-attach-delivery-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-attach-delivery-test-logs"
  };
}

function textParts(parts: MessageContentPart[]): string[] {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text);
}

function documentParts(parts: MessageContentPart[]) {
  return parts.filter((p) => p.type === "document");
}

// Find a BEGIN/END UNTRUSTED FILE block carrying a matching random nonce and
// return the body between the markers. The nonce is per-file and unpredictable
// (anti-spoofing), so the test matches on structure, not literal marker text.
const UNTRUSTED_BLOCK = /<<<BEGIN UNTRUSTED FILE ([0-9a-f-]+)>>>\n([\s\S]*)\n<<<END UNTRUSTED FILE \1>>>/;

function untrustedBlockBody(text: string): string | null {
  const m = text.match(UNTRUSTED_BLOCK);
  return m ? m[2]! : null;
}

describe("attachment delivery", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;
  let config: RuntimeConfig;
  let instanceCounter = 0;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-attach-state-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-attach-ws-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    config = buildConfig(workspaceRoot, `attach-delivery-${instanceCounter++}`);
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("current-turn PDF on a nativeDocs provider yields a document part and materializes the file", async () => {
    const pdf = new Uint8Array(readFileSync(join(FIXTURES, "sample.pdf")));
    const upload = storeUpload(config.instance, pdf, "application/pdf", "report.pdf");

    const parts = await buildAttachmentContent(
      config,
      "look at this",
      [{ id: upload.id, mimeType: "application/pdf", size: upload.size }],
      NATIVE,
      true
    );

    const docs = documentParts(parts);
    expect(docs.length).toBe(1);
    const doc = docs[0]! as { type: "document"; document: { mimeType: string; data: string; filename?: string } };
    expect(doc.document.mimeType).toBe("application/pdf");
    expect(doc.document.filename).toBe("report.pdf");
    expect(doc.document.data.length).toBeGreaterThan(0);
    // base64 round-trips back to the original bytes (no data: prefix).
    expect(Buffer.from(doc.document.data, "base64").length).toBe(pdf.length);
    // A note names the file and points at the workspace path.
    expect(textParts(parts).some((t) => t.includes("provided natively above"))).toBe(true);
    // The file is on disk in the workspace.
    expect(existsSync(join(workspaceRoot, "uploads", upload.id, "report.pdf"))).toBe(true);
  });

  test("current-turn PDF on a text-only provider inlines extracted text, no document part", async () => {
    const pdf = new Uint8Array(readFileSync(join(FIXTURES, "sample.pdf")));
    const upload = storeUpload(config.instance, pdf, "application/pdf", "report.pdf");

    const parts = await buildAttachmentContent(
      config,
      "summarize",
      [{ id: upload.id, mimeType: "application/pdf", size: upload.size }],
      TEXT_ONLY,
      true
    );

    expect(documentParts(parts).length).toBe(0);
    const joined = textParts(parts).join("\n");
    const body = untrustedBlockBody(joined);
    expect(body).not.toBeNull();
    expect(body!).toContain("Hello Gini PDF fixture");
    expect(joined).toContain("untrusted external data");
  });

  test("current-turn CSV inlines utf8 content with boundary markers + materializes", async () => {
    const csv = "name,score\nada,99\ngrace,100\n";
    const upload = storeUpload(config.instance, new TextEncoder().encode(csv), "text/csv", "scores.csv");

    const parts = await buildAttachmentContent(
      config,
      "totals?",
      [{ id: upload.id, mimeType: "text/csv", size: upload.size }],
      NATIVE,
      true
    );

    expect(documentParts(parts).length).toBe(0);
    const joined = textParts(parts).join("\n");
    const body = untrustedBlockBody(joined);
    expect(body).not.toBeNull();
    expect(body!).toContain("ada,99");
    expect(joined).toContain("saved to your workspace at uploads/" + upload.id);
    expect(existsSync(join(workspaceRoot, "uploads", upload.id, "scores.csv"))).toBe(true);
  });

  test("replay turn yields a path-only note (no inline, no document part)", async () => {
    const pdf = new Uint8Array(readFileSync(join(FIXTURES, "sample.pdf")));
    const upload = storeUpload(config.instance, pdf, "application/pdf", "report.pdf");

    const parts = await buildAttachmentContent(
      config,
      "earlier turn",
      [{ id: upload.id, mimeType: "application/pdf", size: upload.size }],
      NATIVE,
      false
    );

    expect(documentParts(parts).length).toBe(0);
    const joined = textParts(parts).join("\n");
    expect(untrustedBlockBody(joined)).toBeNull();
    expect(joined).toContain("[Attached file: report.pdf (application/pdf");
    expect(joined).toContain("saved to your workspace at uploads/" + upload.id);
    // Still materialized on replay.
    expect(existsSync(join(workspaceRoot, "uploads", upload.id, "report.pdf"))).toBe(true);
  });

  test("unsupported format yields a path-only note", async () => {
    const upload = storeUpload(config.instance, new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "application/zip", "bundle.zip");

    const parts = await buildAttachmentContent(
      config,
      "what's in here",
      [{ id: upload.id, mimeType: "application/zip", size: upload.size }],
      NATIVE,
      true
    );

    expect(documentParts(parts).length).toBe(0);
    const joined = textParts(parts).join("\n");
    expect(untrustedBlockBody(joined)).toBeNull();
    expect(joined).toContain("[Attached file: bundle.zip (application/zip");
    expect(joined).toContain("saved to your workspace at uploads/" + upload.id);
  });

  test("inlined text over 256KB is truncated with a note", async () => {
    // 300KB of single-byte ASCII so byte length == char length.
    const big = "x".repeat(300 * 1024);
    const upload = storeUpload(config.instance, new TextEncoder().encode(big), "text/plain", "big.txt");

    const parts = await buildAttachmentContent(
      config,
      "read it",
      [{ id: upload.id, mimeType: "text/plain", size: upload.size }],
      TEXT_ONLY,
      true
    );

    const wrapped = textParts(parts).find((t) => untrustedBlockBody(t) !== null)!;
    expect(wrapped).toBeDefined();
    expect(wrapped).toContain("truncated to 256KB");
    // Inlined body (between the markers) is capped at 256KB, not the full 300KB.
    const body = untrustedBlockBody(wrapped)!;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(body.length).toBeLessThan(big.length);
  });

  test("truncation cuts on a UTF-8 boundary: no replacement char, strictly under the byte cap", async () => {
    // "中" is a 3-byte UTF-8 char; 256KB is not a multiple of 3, so a naive
    // byte slice at exactly MAX_INLINE_BYTES would split the final char into a
    // U+FFFD replacement char and push the result over the cap.
    const big = "中".repeat(100 * 1024); // ~300KB of 3-byte chars
    const upload = storeUpload(config.instance, new TextEncoder().encode(big), "text/plain", "cjk.txt");

    const parts = await buildAttachmentContent(
      config,
      "read it",
      [{ id: upload.id, mimeType: "text/plain", size: upload.size }],
      TEXT_ONLY,
      true
    );

    const wrapped = textParts(parts).find((t) => untrustedBlockBody(t) !== null)!;
    const body = untrustedBlockBody(wrapped)!;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(256 * 1024);
    // The cut landed on a char boundary — no corrupted tail.
    expect(body).not.toContain("�");
    // Body is whole 3-byte chars only.
    expect(Buffer.byteLength(body, "utf8") % 3).toBe(0);
  });

  test("a non-nativeDocs provider never yields a document part even for a PDF", async () => {
    const pdf = new Uint8Array(readFileSync(join(FIXTURES, "sample.pdf")));
    const upload = storeUpload(config.instance, pdf, "application/pdf", "report.pdf");

    const parts = await buildAttachmentContent(
      config,
      "gate",
      [{ id: upload.id, mimeType: "application/pdf", size: upload.size }],
      TEXT_ONLY,
      true
    );

    expect(documentParts(parts).length).toBe(0);
  });

  test("current-turn image on a non-vision provider degrades to a note plus a steering directive", async () => {
    // A real-ish PNG header is enough; uploadDataUrl just base64s the bytes.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const upload = storeUpload(config.instance, png, "image/png", "pic.png");

    const parts = await buildAttachmentContent(
      config,
      "see this",
      [{ id: upload.id, mimeType: "image/png", size: upload.size }],
      TEXT_ONLY, // vision:false must NOT emit an image_url part a text-only provider would 400 on
      true
    );

    expect(parts.every((p) => p.type !== "image_url")).toBe(true);
    const joined = textParts(parts).join("\n");
    // Terse per-image note is still present.
    expect(joined).toContain("not shown: the active model can't view images");
    // The arrival turn carries the directive so the agent refuses in-band
    // instead of hallucinating the image contents.
    expect(joined).toContain("You cannot see the image(s) above");
    expect(joined).toContain("Do not guess or infer their contents");
    expect(joined).toContain("switch to a vision-capable model");
  });

  test("prior-turn image on a non-vision provider degrades to a terse note with no steering directive", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const upload = storeUpload(config.instance, png, "image/png", "pic.png");

    const parts = await buildAttachmentContent(
      config,
      "earlier turn",
      [{ id: upload.id, mimeType: "image/png", size: upload.size }],
      TEXT_ONLY,
      false // replay turn — terse note only, no directive, to bound replay context
    );

    expect(parts.every((p) => p.type !== "image_url")).toBe(true);
    const joined = textParts(parts).join("\n");
    expect(joined).toContain("not shown: the active model can't view images");
    expect(joined).not.toContain("You cannot see the image(s) above");
  });

  test("image attachment on a vision provider stays an image_url part", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const upload = storeUpload(config.instance, png, "image/png", "pic.png");

    const parts = await buildAttachmentContent(
      config,
      "see this",
      [{ id: upload.id, mimeType: "image/png", size: upload.size }],
      NATIVE, // vision:true keeps the inlined image bytes
      true
    );

    expect(parts.some((p) => p.type === "image_url")).toBe(true);
  });
});
