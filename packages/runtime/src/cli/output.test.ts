// Coverage for the CLI's outbound-attachment render: a terminal can't show a
// picture (or a PDF), so renderOutboundAttachments parses the `gini-upload://`
// refs the model pasted into its reply text, fetches each upload, and writes it
// to a path, returning how many it saved. The fetch/save/write deps are injected
// so this runs without a live gateway or filesystem.

import { describe, expect, test } from "bun:test";
import { renderOutboundAttachments } from "./output";

// The fetcher reports bytes + the mime it learned from the response, mirroring
// the real CLI deps (the markdown ref carries no mime). Bytes encode the id
// length so a test can assert the right id's bytes landed at the right path.
function deps(saved: { path: string; bytes: Uint8Array }[], mimeById: Record<string, string> = {}) {
  return {
    fetchUpload: async (id: string) => ({
      bytes: new Uint8Array([id.length, 1, 2, 3]),
      mimeType: mimeById[id] ?? "image/png"
    }),
    savePath: (id: string, mimeType: string) => `/tmp/gini-${id}.${mimeType.split("/")[1]}`,
    writeFile: (path: string, bytes: Uint8Array) => {
      saved.push({ path, bytes });
    }
  };
}

describe("renderOutboundAttachments", () => {
  test("saves each attachment referenced inline in the reply text and returns the count", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [
      { kind: "tool_result", preview: "screenshot ![image](gini-upload://up_a)" },
      { kind: "assistant_text", text: "Here are the files:\n- [report.pdf](gini-upload://up_b)" }
    ];
    const count = await renderOutboundAttachments(
      blocks,
      deps(saved, { up_a: "image/png", up_b: "application/pdf" })
    );
    expect(count).toBe(2);
    expect(saved.map((s) => s.path)).toEqual(["/tmp/gini-up_a.png", "/tmp/gini-up_b.pdf"]);
  });

  test("saves NON-image attachments too (a PDF/CSV ref is honored, not skipped)", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [{ kind: "assistant_text", text: "[data.csv](gini-upload://up_csv)" }];
    const count = await renderOutboundAttachments(blocks, deps(saved, { up_csv: "text/csv" }));
    expect(count).toBe(1);
    expect(saved.map((s) => s.path)).toEqual(["/tmp/gini-up_csv.csv"]);
  });

  test("skips inbound user_text refs (outbound-only — the user already has their uploads)", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [
      { kind: "user_text", text: "my upload ![image](gini-upload://up_inbound)" },
      { kind: "tool_result", preview: "![image](gini-upload://up_outbound)" }
    ];
    const count = await renderOutboundAttachments(blocks, deps(saved));
    expect(count).toBe(1);
    expect(saved.map((s) => s.path)).toEqual(["/tmp/gini-up_outbound.png"]);
  });

  test("dedupes a ref that appears in more than one block (saved once)", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [
      { kind: "assistant_text", text: "see ![image](gini-upload://dup)" },
      { kind: "tool_result", preview: "again ![image](gini-upload://dup)" }
    ];
    expect(await renderOutboundAttachments(blocks, deps(saved))).toBe(1);
    expect(saved.length).toBe(1);
  });

  test("skips a block with no kind", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [{ text: "![image](gini-upload://up_x)" }];
    expect(await renderOutboundAttachments(blocks, deps(saved))).toBe(0);
  });

  test("skips a block whose text field is missing or not a string", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [
      { kind: "assistant_text" },
      { kind: "tool_result", preview: 42 },
      { kind: "assistant_text", text: "no refs here" }
    ];
    expect(await renderOutboundAttachments(blocks, deps(saved))).toBe(0);
  });

  test("returns 0 when given a non-array (defensive)", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    expect(await renderOutboundAttachments(null, deps(saved))).toBe(0);
    expect(await renderOutboundAttachments({ not: "an array" }, deps(saved))).toBe(0);
  });

  test("writes the exact bytes returned by the fetcher", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [{ kind: "tool_result", preview: "![image](gini-upload://abcd)" }];
    await renderOutboundAttachments(blocks, deps(saved));
    // deps.fetchUpload returns [id.length, 1, 2, 3]; "abcd".length === 4.
    expect(Array.from(saved[0]!.bytes)).toEqual([4, 1, 2, 3]);
  });
});
