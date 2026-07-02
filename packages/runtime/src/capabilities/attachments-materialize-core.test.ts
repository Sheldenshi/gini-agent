import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { storeUpload } from "../state/uploads";
import type { RuntimeConfig } from "../types";
import { materializeUpload } from "./attachments-materialize-core";

const ROOT = join("/tmp", `gini-materialize-core-${randomUUID()}`);

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function config(instance: string): RuntimeConfig {
  const workspaceRoot = join(ROOT, instance, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: join(ROOT, instance),
    logRoot: join(ROOT, instance, "logs")
  };
}

describe("materializeUpload", () => {
  test("writes upload bytes to uploads/<id>/<filename> and returns metadata", () => {
    const cfg = config("mc-basic");
    const bytes = new TextEncoder().encode("hello world\n");
    const upload = storeUpload(cfg.instance, bytes, "text/plain", "notes.txt");

    const result = materializeUpload(cfg, upload.id);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(join("uploads", upload.id, "notes.txt"));
    expect(result!.absPath).toBe(join(cfg.workspaceRoot, "uploads", upload.id, "notes.txt"));
    expect(result!.filename).toBe("notes.txt");
    expect(result!.mimeType).toBe("text/plain");
    expect(result!.size).toBe(bytes.length);

    const written = new Uint8Array(readFileSync(result!.absPath));
    expect(written).toEqual(bytes);
  });

  test("falls back to <id>.<ext> when the manifest has no filename", () => {
    const cfg = config("mc-noname");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const upload = storeUpload(cfg.instance, bytes, "application/pdf");

    const result = materializeUpload(cfg, upload.id);
    expect(result).not.toBeNull();
    // application/pdf isn't in the image extension map, so it lands as
    // `<id>.pdf` (mime subtype).
    expect(result!.filename).toBe(`${upload.id}.pdf`);
    expect(result!.path).toBe(join("uploads", upload.id, `${upload.id}.pdf`));

    const written = new Uint8Array(readFileSync(result!.absPath));
    expect(written).toEqual(bytes);
  });

  test("sanitizes a filename with directory components into a single segment", () => {
    const cfg = config("mc-sanitize");
    const bytes = new Uint8Array([9, 9, 9]);
    // A filename that tries to redirect via a path; the destination must
    // stay a single segment under uploads/<id>/.
    const upload = storeUpload(cfg.instance, bytes, "text/plain", "../../etc/passwd");

    const result = materializeUpload(cfg, upload.id);
    expect(result).not.toBeNull();
    // No directory traversal survives; the result sits under uploads/<id>/.
    expect(result!.absPath.startsWith(join(cfg.workspaceRoot, "uploads", upload.id) + "/")).toBe(true);
    expect(result!.filename).not.toContain("/");
    expect(result!.filename).not.toContain("..");
  });

  test("is idempotent: a second call does not rewrite an unchanged file", () => {
    const cfg = config("mc-idempotent");
    const bytes = new TextEncoder().encode("stable bytes");
    const upload = storeUpload(cfg.instance, bytes, "text/plain", "stable.txt");

    const first = materializeUpload(cfg, upload.id);
    expect(first).not.toBeNull();
    const mtime1 = statSync(first!.absPath).mtimeMs;

    // Tamper with the on-disk mtime baseline; a same-size file should be
    // treated as already materialized and left untouched.
    const second = materializeUpload(cfg, upload.id);
    expect(second).not.toBeNull();
    const mtime2 = statSync(second!.absPath).mtimeMs;
    expect(mtime2).toBe(mtime1);
    expect(new Uint8Array(readFileSync(second!.absPath))).toEqual(bytes);
  });

  test("rewrites when an existing destination has a different byte length", () => {
    const cfg = config("mc-rewrite");
    const bytes = new TextEncoder().encode("real bytes here");
    const upload = storeUpload(cfg.instance, bytes, "text/plain", "doc.txt");

    // Pre-seed a stale partial of a different length at the destination.
    const destDir = join(cfg.workspaceRoot, "uploads", upload.id);
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "doc.txt"), new Uint8Array([0]));

    const result = materializeUpload(cfg, upload.id);
    expect(result).not.toBeNull();
    expect(new Uint8Array(readFileSync(result!.absPath))).toEqual(bytes);
  });

  test("returns null for an unknown upload", () => {
    const cfg = config("mc-missing");
    expect(materializeUpload(cfg, "does-not-exist")).toBeNull();
  });

  test("refuses to write through a symlinked destination directory", () => {
    const cfg = config("mc-symlink");
    const bytes = new Uint8Array([4, 2, 4, 2]);
    const upload = storeUpload(cfg.instance, bytes, "text/plain", "evil.txt");

    // Make uploads/ a symlink pointing outside the workspace. The escape
    // guard's symlink walk must reject before any write.
    const outside = join(ROOT, cfg.instance, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(cfg.workspaceRoot, "uploads"));

    expect(() => materializeUpload(cfg, upload.id)).toThrow(/symlink/i);
    // Nothing was written through the link.
    expect(() => statSync(join(outside, upload.id, "evil.txt"))).toThrow();
  });

  test("does not blindly return a same-size destination that is a symlink escaping the workspace", () => {
    const cfg = config("mc-symlink-fastpath");
    const bytes = new TextEncoder().encode("same-size payload");
    const upload = storeUpload(cfg.instance, bytes, "text/plain", "escape.txt");

    // Plant an outside file with the SAME byte length as the upload, then make
    // the destination path a symlink to it. existsSync + size-match would let
    // the idempotent fast path return the symlink and read through it (escape),
    // so the fast path must run the symlink-safe guard first.
    const outsideDir = join(ROOT, cfg.instance, "outside");
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, "outside.txt");
    writeFileSync(outsideFile, bytes);

    const destDir = join(cfg.workspaceRoot, "uploads", upload.id);
    mkdirSync(destDir, { recursive: true });
    const destLink = join(destDir, "escape.txt");
    symlinkSync(outsideFile, destLink);

    // The escaping symlink must not be blindly returned. The guarded rewrite
    // rejects the symlinked destination component.
    expect(() => materializeUpload(cfg, upload.id)).toThrow(/symlink/i);
    // The outside file was not overwritten through the link, and no path that
    // resolves outside the workspace was returned.
    expect(new Uint8Array(readFileSync(outsideFile))).toEqual(bytes);
  });
});
