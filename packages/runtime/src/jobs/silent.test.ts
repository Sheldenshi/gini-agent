import { describe, expect, test } from "bun:test";
import { isSilentReply } from "./silent";

describe("isSilentReply", () => {
  test("exact sentinel is silent", () => {
    expect(isSilentReply("[SILENT]")).toBe(true);
  });

  test("trailing sentinel line after a no-op preamble is silent", () => {
    expect(isSilentReply("No change.\n\n[SILENT]")).toBe(true);
  });

  test("leading/inline sentinel still delivers", () => {
    expect(isSilentReply("[SILENT] but here's an update")).toBe(false);
  });

  test("leading sentinel on its own line still delivers", () => {
    expect(isSilentReply("[SILENT]\nbut here's an update")).toBe(false);
  });

  test("empty and whitespace are not silent", () => {
    expect(isSilentReply("")).toBe(false);
    expect(isSilentReply("   \n  ")).toBe(false);
    expect(isSilentReply(undefined)).toBe(false);
    expect(isSilentReply(null)).toBe(false);
  });

  test("real report is not silent", () => {
    expect(isSilentReply("real report")).toBe(false);
  });
});
