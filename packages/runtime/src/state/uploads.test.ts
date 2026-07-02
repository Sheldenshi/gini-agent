// Coverage for uploadPathFor — resolving a stored upload's on-disk blob path.
// Outbound dispatch paths (e.g. mirroring a screenshot to Telegram) need the
// file path, not the bytes, so this guards that the path resolves for a real
// upload and returns null for a missing/half-written one.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readUpload, storeUpload, uploadPathFor, uploadStat } from "./uploads";
import { uploadsDir } from "../paths";

const ROOT = "/tmp/gini-uploads-pathfor-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("uploadPathFor", () => {
  test("resolves the on-disk blob path for a stored image upload", () => {
    const stored = storeUpload("up-path-1", new Uint8Array([1, 2, 3, 4]), "image/png", "shot.png");
    const path = uploadPathFor("up-path-1", stored.id);
    expect(path).not.toBeNull();
    expect(path!.endsWith(`${stored.id}.png`)).toBe(true);
    expect(existsSync(path!)).toBe(true);
  });

  test("returns null for an unknown upload id (no manifest)", () => {
    expect(uploadPathFor("up-path-2", "does-not-exist")).toBeNull();
  });

  test("returns null when the manifest exists but the blob was removed", () => {
    const stored = storeUpload("up-path-3", new Uint8Array([9, 9]), "image/jpeg");
    const path = uploadPathFor("up-path-3", stored.id);
    expect(path).not.toBeNull();
    // Delete the blob but leave the manifest — a half-written upload must
    // resolve to null rather than a path that 404s on read.
    unlinkSync(path!);
    expect(uploadPathFor("up-path-3", stored.id)).toBeNull();
  });
});

// The blob extension is chosen by the writer. storeUpload and the promote-file
// skill script use DIFFERENT mime→ext maps: for text/markdown, promote-file
// writes `<id>.md` while uploads.ts's extensionFor derives `markdown`. The
// reader must find the blob regardless of which extension the writer chose, or
// a promoted markdown file 404s even though it's plainly on disk. These pin the
// extension-drift tolerance across readUpload / uploadStat / uploadPathFor.
describe("blob resolution tolerates writer extension drift", () => {
  const INSTANCE = "up-drift";

  test("readUpload finds a `.md` blob even though extensionFor computes `markdown`", () => {
    const stored = storeUpload(INSTANCE, new TextEncoder().encode("# Title\n"), "text/markdown", "notes.md");
    const dir = uploadsDir(INSTANCE);
    // Mimic promote-file: the blob lives at `<id>.md`, not `<id>.markdown`.
    renameSync(join(dir, `${stored.id}.markdown`), join(dir, `${stored.id}.md`));
    const got = readUpload(INSTANCE, stored.id);
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.bytes)).toBe("# Title\n");
    expect(got!.mimeType).toBe("text/markdown");
  });

  test("uploadStat and uploadPathFor also resolve the drifted `.md` blob", () => {
    const stored = storeUpload(INSTANCE, new TextEncoder().encode("hello"), "text/markdown", "notes.md");
    const dir = uploadsDir(INSTANCE);
    renameSync(join(dir, `${stored.id}.markdown`), join(dir, `${stored.id}.md`));
    const stat = uploadStat(INSTANCE, stored.id);
    expect(stat).not.toBeNull();
    expect(stat!.size).toBe(5);
    const path = uploadPathFor(INSTANCE, stored.id);
    expect(path!.endsWith(`${stored.id}.md`)).toBe(true);
  });

  test("the fallback never resolves the manifest or a vision-variant cache as the blob", () => {
    const stored = storeUpload(INSTANCE, new Uint8Array([1, 2, 3]), "image/png", "x.png");
    const dir = uploadsDir(INSTANCE);
    // Remove the real blob and drop a vision-variant cache file next to the
    // manifest. The resolver must NOT mistake `<id>.json` or `<id>.vis-*.jpg`
    // for the blob — it should resolve to null, not the cache/manifest.
    unlinkSync(join(dir, `${stored.id}.png`));
    writeFileSync(join(dir, `${stored.id}.vis-5242880.jpg`), new Uint8Array([7, 7]));
    expect(uploadPathFor(INSTANCE, stored.id)).toBeNull();
    expect(readUpload(INSTANCE, stored.id)).toBeNull();
  });
});
