// Coverage for the canonical upload-ref scheme that carries an agent-produced
// attachment inline in the reply text (gini-upload://<id>).

import { describe, expect, test } from "bun:test";
import {
  UPLOAD_REF_SCHEME,
  uploadRefFor,
  uploadTagFor,
  imageTagFor,
  uploadIdFromRef,
  uploadIdsFromText
} from "./upload-ref";

describe("uploadRefFor / imageTagFor / uploadTagFor", () => {
  test("uploadRefFor builds the scheme-prefixed ref", () => {
    expect(uploadRefFor("abc")).toBe("gini-upload://abc");
    expect(UPLOAD_REF_SCHEME).toBe("gini-upload://");
  });

  test("imageTagFor builds an image markdown tag", () => {
    expect(imageTagFor("up1", "screenshot")).toBe("![screenshot](gini-upload://up1)");
  });

  test("uploadTagFor builds an image tag for an image mime", () => {
    expect(uploadTagFor("up1", { mimeType: "image/png", alt: "shot" })).toBe("![shot](gini-upload://up1)");
  });

  test("uploadTagFor builds a link tag (filename label) for a non-image mime", () => {
    expect(uploadTagFor("up1", { mimeType: "application/pdf", filename: "report.pdf" })).toBe(
      "[report.pdf](gini-upload://up1)"
    );
  });

  test("uploadTagFor falls back to a generic label when no filename/alt", () => {
    expect(uploadTagFor("up1", { mimeType: "text/csv" })).toBe("[file](gini-upload://up1)");
    expect(uploadTagFor("up1")).toBe("[file](gini-upload://up1)");
  });

  test("labels are sanitized so they can't break the markdown tag", () => {
    expect(uploadTagFor("up1", { mimeType: "image/png", alt: "a]b\nc" })).toBe("![a b c](gini-upload://up1)");
  });
});

describe("uploadIdFromRef", () => {
  test("extracts the id from a valid ref", () => {
    expect(uploadIdFromRef("gini-upload://abc-123")).toBe("abc-123");
  });

  test("returns null for a foreign URL (SSRF guard)", () => {
    expect(uploadIdFromRef("https://evil.example/pixel.gif")).toBeNull();
    expect(uploadIdFromRef("/api/uploads/abc")).toBeNull();
    expect(uploadIdFromRef(undefined)).toBeNull();
    expect(uploadIdFromRef("")).toBeNull();
  });

  test("returns null for a ref with an invalid id charset", () => {
    expect(uploadIdFromRef("gini-upload://has spaces")).toBeNull();
    expect(uploadIdFromRef("gini-upload://")).toBeNull();
  });
});

describe("uploadIdsFromText", () => {
  test("pulls every distinct ref out of reply text, in first-seen order", () => {
    const text = "First ![a](gini-upload://id1) then ![b](gini-upload://id2) and again gini-upload://id1.";
    expect(uploadIdsFromText(text)).toEqual(["id1", "id2"]);
  });

  test("returns empty for text with no refs", () => {
    expect(uploadIdsFromText("just a normal reply, no images")).toEqual([]);
  });
});
