// Coverage for the CLI's outbound-image render: a terminal can't show pixels,
// so renderOutboundImages fetches each image upload and writes it to a path,
// returning how many it saved. The fetch/save/write deps are injected so this
// runs without a live gateway or filesystem.

import { describe, expect, test } from "bun:test";
import { renderOutboundImages } from "./output";

function deps(saved: { path: string; bytes: Uint8Array }[]) {
  return {
    fetchUpload: async (id: string) => new Uint8Array([id.length, 1, 2, 3]),
    savePath: (id: string, mimeType: string) => `/tmp/gini-${id}.${mimeType.split("/")[1]}`,
    writeFile: (path: string, bytes: Uint8Array) => {
      saved.push({ path, bytes });
    }
  };
}

describe("renderOutboundImages", () => {
  test("saves each image-mime attachment and returns the count", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [
      { kind: "tool_result", images: [{ id: "up_a", mimeType: "image/png", size: 10 }] },
      { kind: "assistant_text", images: [{ id: "up_b", mimeType: "image/jpeg", size: 20 }] }
    ];
    const count = await renderOutboundImages(blocks, deps(saved));
    expect(count).toBe(2);
    expect(saved.map((s) => s.path)).toEqual(["/tmp/gini-up_a.png", "/tmp/gini-up_b.jpeg"]);
  });

  test("skips inbound user_text images (outbound-only — the user already has their uploads)", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [
      { kind: "user_text", images: [{ id: "up_inbound", mimeType: "image/png", size: 5 }] },
      { kind: "tool_result", images: [{ id: "up_outbound", mimeType: "image/png", size: 6 }] }
    ];
    const count = await renderOutboundImages(blocks, deps(saved));
    expect(count).toBe(1);
    expect(saved.map((s) => s.path)).toEqual(["/tmp/gini-up_outbound.png"]);
  });

  test("skips a block with no kind", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [{ images: [{ id: "up_x", mimeType: "image/png", size: 1 }] }];
    expect(await renderOutboundImages(blocks, deps(saved))).toBe(0);
  });

  test("skips non-image attachments (a CSV upload is not saved as an image)", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [{ kind: "tool_result", images: [{ id: "up_csv", mimeType: "text/csv", size: 9 }] }];
    const count = await renderOutboundImages(blocks, deps(saved));
    expect(count).toBe(0);
    expect(saved.length).toBe(0);
  });

  test("skips an attachment with no id", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [{ kind: "tool_result", images: [{ id: "", mimeType: "image/png", size: 1 }] }];
    expect(await renderOutboundImages(blocks, deps(saved))).toBe(0);
  });

  test("returns 0 for a block list with no images", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [{ kind: "assistant_text", text: "hi" }, { kind: "phase", label: "Completed" }];
    expect(await renderOutboundImages(blocks, deps(saved))).toBe(0);
  });

  test("returns 0 when given a non-array (defensive)", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    expect(await renderOutboundImages(null, deps(saved))).toBe(0);
    expect(await renderOutboundImages({ not: "an array" }, deps(saved))).toBe(0);
  });

  test("writes the exact bytes returned by the fetcher", async () => {
    const saved: { path: string; bytes: Uint8Array }[] = [];
    const blocks = [{ kind: "tool_result", images: [{ id: "abcd", mimeType: "image/png", size: 4 }] }];
    await renderOutboundImages(blocks, deps(saved));
    // deps.fetchUpload returns [id.length, 1, 2, 3]; "abcd".length === 4.
    expect(Array.from(saved[0]!.bytes)).toEqual([4, 1, 2, 3]);
  });
});
