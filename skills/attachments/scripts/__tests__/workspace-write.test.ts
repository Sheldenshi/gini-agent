import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  WorkspaceEscapeError,
  assertInsideWorkspace,
  assertNoSymlinkOnPath,
  writeInsideWorkspace
} from "../workspace-write";

const ROOT = join("/tmp", `gini-workspace-write-${randomUUID()}`);
const WORKSPACE = join(ROOT, "workspace");

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("assertInsideWorkspace", () => {
  test("accepts a relative path inside the workspace", () => {
    expect(assertInsideWorkspace(WORKSPACE, "a/b.txt")).toBe(join(WORKSPACE, "a/b.txt"));
  });

  test("accepts an absolute path inside the workspace", () => {
    const abs = join(WORKSPACE, "x.txt");
    expect(assertInsideWorkspace(WORKSPACE, abs)).toBe(abs);
  });

  test("rejects relative traversal out of the workspace", () => {
    expect(() => assertInsideWorkspace(WORKSPACE, "../escape.txt")).toThrow(WorkspaceEscapeError);
    expect(() => assertInsideWorkspace(WORKSPACE, "a/../../escape.txt")).toThrow(/outside workspace/i);
  });

  test("rejects an absolute path outside the workspace", () => {
    expect(() => assertInsideWorkspace(WORKSPACE, join(ROOT, "outside.txt"))).toThrow(WorkspaceEscapeError);
  });

  test("does not treat a sibling sharing the root prefix as inside", () => {
    // `${WORKSPACE}-evil` shares the string prefix but is not inside.
    expect(() => assertInsideWorkspace(WORKSPACE, `${WORKSPACE}-evil/x.txt`)).toThrow(/outside workspace/i);
  });
});

describe("assertNoSymlinkOnPath", () => {
  test("accepts a clean path and stops walking at the first missing component", () => {
    mkdirSync(join(WORKSPACE, "real"), { recursive: true });
    expect(() => assertNoSymlinkOnPath(WORKSPACE, join(WORKSPACE, "real", "missing", "leaf.txt"))).not.toThrow();
  });

  test("rejects a symlinked component with a WorkspaceEscapeError", () => {
    symlinkSync(join(ROOT, "elsewhere"), join(WORKSPACE, "sym"));
    let caught: unknown;
    try {
      assertNoSymlinkOnPath(WORKSPACE, join(WORKSPACE, "sym", "leaf.txt"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceEscapeError);
    expect(caught).toBeInstanceOf(Error);
  });
});

describe("writeInsideWorkspace", () => {
  test("writes bytes and creates parent dirs", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const abs = writeInsideWorkspace(WORKSPACE, "deep/nested/out.bin", bytes);
    expect(abs).toBe(join(WORKSPACE, "deep/nested/out.bin"));
    expect(new Uint8Array(readFileSync(abs))).toEqual(bytes);
  });

  test("refuses a destination symlink pointing outside the workspace", () => {
    const outside = join(ROOT, "outside-target");
    writeFileSync(outside, new Uint8Array([0]));
    symlinkSync(outside, join(WORKSPACE, "link.txt"));
    expect(() => writeInsideWorkspace(WORKSPACE, "link.txt", new Uint8Array([7])))
      .toThrow(/symlink/i);
    // The link target is untouched.
    expect(new Uint8Array(readFileSync(outside))).toEqual(new Uint8Array([0]));
  });

  test("refuses a symlinked intermediate directory", () => {
    const outsideDir = join(ROOT, "outdir");
    symlinkSync(outsideDir, join(WORKSPACE, "plink"));
    expect(() => writeInsideWorkspace(WORKSPACE, "plink/sub/x.txt", new Uint8Array([1])))
      .toThrow(/symlink/i);
    expect(() => readFileSync(join(outsideDir, "sub", "x.txt"))).toThrow();
  });
});
