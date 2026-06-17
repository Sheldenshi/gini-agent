// Pure skill-body edit ops (ADR skill-learning-from-outcomes.md): each op
// against a sample body; a no-match is skipped + recorded, never thrown.

import { describe, expect, test } from "bun:test";
import { applySkillEdits } from "./edits";

const SAMPLE = `# Payment flow

1. Open the invoice.
2. Click Pay.`;

describe("applySkillEdits", () => {
  test("append adds content at the end", () => {
    const out = applySkillEdits(SAMPLE, [{ op: "append", content: "3. Confirm the payee." }]);
    expect(out.applied).toBe(1);
    expect(out.skipped).toHaveLength(0);
    expect(out.body.endsWith("3. Confirm the payee.")).toBe(true);
    expect(out.body).toContain("2. Click Pay.");
  });

  test("insert_after inserts following an exact anchor", () => {
    const out = applySkillEdits(SAMPLE, [
      { op: "insert_after", anchor: "1. Open the invoice.", content: "1a. Verify the amount." }
    ]);
    expect(out.applied).toBe(1);
    expect(out.body).toContain("1. Open the invoice.\n1a. Verify the amount.");
  });

  test("replace swaps an exact target substring", () => {
    const out = applySkillEdits(SAMPLE, [
      { op: "replace", target: "2. Click Pay.", content: "2. Confirm, then click Pay." }
    ]);
    expect(out.applied).toBe(1);
    expect(out.body).toContain("2. Confirm, then click Pay.");
    expect(out.body).not.toContain("2. Click Pay.");
  });

  test("delete removes an exact target substring", () => {
    const out = applySkillEdits(SAMPLE, [{ op: "delete", target: "\n2. Click Pay." }]);
    expect(out.applied).toBe(1);
    expect(out.body).not.toContain("Click Pay");
  });

  test("no-match is skipped and recorded, never thrown", () => {
    const ops: Parameters<typeof applySkillEdits>[1] = [
      { op: "replace", target: "nonexistent text", content: "x" },
      { op: "insert_after", anchor: "also missing", content: "y" },
      { op: "delete", target: "missing too" }
    ];
    const out = applySkillEdits(SAMPLE, ops);
    expect(out.applied).toBe(0);
    expect(out.skipped).toHaveLength(3);
    // Body is unchanged when nothing matched.
    expect(out.body).toBe(SAMPLE);
  });

  test("a mixed batch applies the matches and skips the rest", () => {
    const out = applySkillEdits(SAMPLE, [
      { op: "append", content: "3. Done." },
      { op: "replace", target: "nope", content: "x" }
    ]);
    expect(out.applied).toBe(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.body).toContain("3. Done.");
  });
});
