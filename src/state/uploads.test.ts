// Coverage for uploadPathFor — resolving a stored upload's on-disk blob path.
// Outbound dispatch paths (e.g. mirroring a screenshot to Telegram) need the
// file path, not the bytes, so this guards that the path resolves for a real
// upload and returns null for a missing/half-written one.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { storeUpload, uploadPathFor } from "./uploads";

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
