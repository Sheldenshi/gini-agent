import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Drive the materialize script exactly as the runtime does
// (skill-scripts.ts: `bun run <script>` with GINI_UPLOADS_DIR /
// GINI_WORKSPACE in env and JSON args on stdin), then assert the
// upload round-trips byte-for-byte onto disk and the guards hold.

const SCRIPT = resolve(import.meta.dir, "../../../../skills/attachments/scripts/materialize.ts");
const ROOT = join("/tmp", `gini-materialize-${randomUUID()}`);
const UPLOADS = join(ROOT, "uploads");
const WORKSPACE = join(ROOT, "workspace");

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(UPLOADS, { recursive: true });
  mkdirSync(WORKSPACE, { recursive: true });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// Name the blob exactly the way the core upload store does
// (src/state/uploads.ts `extensionFor`): a fixed map for the common image
// mimes, otherwise the mime subtype with non-alphanumerics stripped. This
// is what makes the round-trip exercise the real on-disk layout — e.g.
// text/markdown lands as `<id>.markdown`, not `<id>.md`.
function coreExtensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/heic": return "heic";
    case "image/heif": return "heif";
    case "image/svg+xml": return "svg";
    default: {
      const slash = mimeType.indexOf("/");
      return slash >= 0 ? mimeType.slice(slash + 1).replace(/[^a-z0-9]/gi, "") || "bin" : "bin";
    }
  }
}

function storeUpload(bytes: Uint8Array, mimeType: string, filename?: string): string {
  const id = randomUUID();
  writeFileSync(join(UPLOADS, `${id}.${coreExtensionFor(mimeType)}`), bytes);
  writeFileSync(
    join(UPLOADS, `${id}.json`),
    JSON.stringify({ id, mimeType, filename, size: bytes.length, createdAt: new Date().toISOString() })
  );
  return id;
}

async function run(args: Record<string, unknown>): Promise<{ exitCode: number; parsed: any; stdout: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", GINI_UPLOADS_DIR: UPLOADS, GINI_WORKSPACE: WORKSPACE }
  });
  const writer = proc.stdin as { write: (d: Uint8Array) => Promise<number>; end: () => void };
  await writer.write(new TextEncoder().encode(JSON.stringify(args)));
  writer.end();
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  let parsed: any = null;
  try { parsed = JSON.parse(stdout.trim()); } catch { /* leave null */ }
  return { exitCode, parsed, stdout };
}

describe("materialize", () => {
  test("round-trips upload bytes to the default destination (manifest filename)", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 255]);
    const id = storeUpload(bytes, "image/png", "screenshot.png");

    const { exitCode, parsed } = await run({ uploadId: id });
    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe("screenshot.png");
    expect(parsed.absPath).toBe(join(WORKSPACE, "screenshot.png"));
    expect(parsed.mimeType).toBe("image/png");
    expect(parsed.size).toBe(bytes.length);
    expect(parsed.filename).toBe("screenshot.png");

    const written = new Uint8Array(readFileSync(join(WORKSPACE, "screenshot.png")));
    expect(written).toEqual(bytes);
  });

  test("writes to an explicit workspace-relative path, creating parent dirs", async () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const id = storeUpload(bytes, "image/png", "ignored.png");

    const { exitCode, parsed } = await run({ uploadId: id, path: "assets/img/out.png" });
    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe("assets/img/out.png");
    expect(parsed.absPath).toBe(join(WORKSPACE, "assets/img/out.png"));

    const written = new Uint8Array(readFileSync(join(WORKSPACE, "assets/img/out.png")));
    expect(written).toEqual(bytes);
  });

  test("falls back to <uploadId>.<ext> when the manifest has no filename", async () => {
    const bytes = new Uint8Array([1, 1, 2, 3, 5, 8]);
    const id = storeUpload(bytes, "image/png");

    const { exitCode, parsed } = await run({ uploadId: id });
    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe(`${id}.png`);

    const written = new Uint8Array(readFileSync(join(WORKSPACE, `${id}.png`)));
    expect(written).toEqual(bytes);
  });

  test("rejects a path that escapes the workspace", async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    const id = storeUpload(bytes, "image/png", "x.png");

    const { exitCode, parsed } = await run({ uploadId: id, path: "../outside.png" });
    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/outside workspace/i);
  });

  test("fails on an unknown uploadId without throwing", async () => {
    const { exitCode, parsed } = await run({ uploadId: "does-not-exist" });
    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Upload not found/);
  });

  test("finds and writes a non-image blob stored with the core store's extension", async () => {
    // text/markdown isn't in the core extension map, so the store writes the
    // blob as `<id>.markdown` (mime subtype, not `.md`). materialize must find
    // it by listing the dir, not by recomputing the extension.
    const bytes = new TextEncoder().encode("# Title\n\nbody\n");
    const id = storeUpload(bytes, "text/markdown", "notes.md");
    expect(existsSync(join(UPLOADS, `${id}.markdown`))).toBe(true);

    const { exitCode, parsed } = await run({ uploadId: id });
    expect(exitCode).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe("notes.md");
    expect(parsed.mimeType).toBe("text/markdown");
    expect(parsed.size).toBe(bytes.length);

    const written = new Uint8Array(readFileSync(join(WORKSPACE, "notes.md")));
    expect(written).toEqual(bytes);
  });

  test("rejects an uploadId that isn't an opaque basename", async () => {
    const { exitCode, parsed } = await run({ uploadId: "../foo" });
    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Invalid uploadId/i);
  });

  test("refuses to write through a destination symlink that points outside the workspace", async () => {
    const bytes = new Uint8Array([4, 2, 4, 2]);
    const id = storeUpload(bytes, "image/png", "evil.png");

    // Pre-create a symlink inside the workspace whose target is outside it.
    const outside = join(ROOT, "outside-target.png");
    writeFileSync(outside, new Uint8Array([0]));
    const link = join(WORKSPACE, "evil.png");
    symlinkSync(outside, link);

    const { exitCode, parsed } = await run({ uploadId: id, path: "evil.png" });
    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/symlink/i);

    // The symlink target must be untouched (the rejection happened pre-write).
    const target = new Uint8Array(readFileSync(outside));
    expect(target).toEqual(new Uint8Array([0]));
  });

  test("refuses a dangling destination symlink without creating its outside target", async () => {
    const bytes = new Uint8Array([9, 9, 9, 9]);
    const id = storeUpload(bytes, "image/png", "dangling.png");

    // A symlink whose target does NOT exist and points outside the workspace.
    // existsSync would follow it and report false, so a per-component lstat
    // walk is what catches it before writeFileSync follows it outside.
    const outside = join(ROOT, "dangling-target.png");
    symlinkSync(outside, join(WORKSPACE, "dangling"));

    const { exitCode, parsed } = await run({ uploadId: id, path: "dangling" });
    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/symlink/i);

    // The write must not have followed the dangling link outside the workspace.
    expect(existsSync(outside)).toBe(false);
  });

  test("refuses a symlinked intermediate parent without creating dirs outside", async () => {
    const bytes = new Uint8Array([5, 6, 7, 8]);
    const id = storeUpload(bytes, "image/png", "x.png");

    // An intermediate dir is a symlink whose target dir does NOT exist.
    // mkdirSync(...,{recursive:true}) would follow it and create the dir tree
    // outside the workspace; the lstat walk must reject before any mkdir.
    const outsideDir = join(ROOT, "out");
    symlinkSync(outsideDir, join(WORKSPACE, "plink"));

    const { exitCode, parsed } = await run({ uploadId: id, path: "plink/sub/x.png" });
    expect(exitCode).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/symlink/i);

    // No directories were created through the symlink outside the workspace.
    expect(existsSync(outsideDir)).toBe(false);
    expect(existsSync(join(outsideDir, "sub"))).toBe(false);
  });
});
