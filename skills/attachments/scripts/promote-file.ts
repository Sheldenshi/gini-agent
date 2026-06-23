#!/usr/bin/env bun
// promote-file skill script.
//
// Contract:
//   stdin:  JSON { path, mimeType? }
//   env:    GINI_WORKSPACE, GINI_UPLOADS_DIR
//   stdout: JSON { ok, uploadId?, mimeType?, size?, filename?, error? }
//   exit:   0 on success, 1 on hard failure
//
// Register a workspace-relative file as a Gini upload. Closes the
// agent-produced-bytes gap: code_exec / terminal_exec / a future
// browser_capture all leave files on disk; this lifts them into the
// upload-addressable space so signed-upload / vision_query can consume.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, normalize, resolve, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

interface Args {
  path: string;
  mimeType?: string;
}

interface Result {
  ok: boolean;
  uploadId?: string;
  mimeType?: string;
  size?: number;
  filename?: string;
  error?: string;
}

const MAX_BYTES = 200 * 1024 * 1024;

async function readStdinJson<T>(): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("Skill script received no stdin payload.");
  return JSON.parse(text) as T;
}

function emit(result: Result, exitCode = 0): never {
  process.stdout.write(JSON.stringify(result));
  process.exit(exitCode);
}

function assertInsideWorkspace(workspaceRoot: string, target: string): string {
  if (isAbsolute(target)) {
    const normalized = normalize(target);
    const root = normalize(workspaceRoot);
    if (normalized !== root && !normalized.startsWith(`${root}/`)) {
      throw new Error(`Path outside workspace: ${target}`);
    }
    return normalized;
  }
  const candidate = normalize(resolve(workspaceRoot, target));
  const root = normalize(workspaceRoot);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error(`Path outside workspace: ${target}`);
  }
  // Confirm relative computation doesn't reveal escape.
  const rel = relative(root, candidate);
  if (rel.startsWith("..")) {
    throw new Error(`Path outside workspace: ${target}`);
  }
  return candidate;
}

function mimeFromExtension(ext: string): string {
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".heic": return "image/heic";
    case ".heif": return "image/heif";
    case ".pdf": return "application/pdf";
    case ".json": return "application/json";
    case ".txt":
    case ".log": return "text/plain";
    case ".md": return "text/markdown";
    case ".csv": return "text/csv";
    case ".html":
    case ".htm": return "text/html";
    case ".xml": return "application/xml";
    case ".zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/heic": return "heic";
    case "image/heif": return "heif";
    case "image/svg+xml": return "svg";
    case "application/pdf": return "pdf";
    case "application/json": return "json";
    case "text/plain": return "txt";
    case "text/markdown": return "md";
    case "text/csv": return "csv";
    case "text/html": return "html";
    case "application/xml": return "xml";
    case "application/zip": return "zip";
    default: {
      const slash = mimeType.indexOf("/");
      return slash >= 0 ? mimeType.slice(slash + 1).replace(/[^a-z0-9]/gi, "") || "bin" : "bin";
    }
  }
}

async function main(): Promise<void> {
  const workspace = process.env.GINI_WORKSPACE;
  const uploadsDir = process.env.GINI_UPLOADS_DIR;
  if (!workspace) emit({ ok: false, error: "Missing GINI_WORKSPACE." }, 1);
  if (!uploadsDir) emit({ ok: false, error: "Missing GINI_UPLOADS_DIR." }, 1);

  let args: Args;
  try {
    args = await readStdinJson<Args>();
  } catch (error) {
    emit({ ok: false, error: `Bad args: ${error instanceof Error ? error.message : String(error)}` }, 1);
  }
  if (!args.path) emit({ ok: false, error: "path is required." }, 1);

  let absolute: string;
  try {
    absolute = assertInsideWorkspace(workspace, args.path);
  } catch (error) {
    emit({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1);
  }
  if (!existsSync(absolute)) emit({ ok: false, error: `File not found: ${args.path}` }, 1);
  const st = statSync(absolute);
  if (!st.isFile()) emit({ ok: false, error: `Not a regular file: ${args.path}` }, 1);
  if (st.size === 0) emit({ ok: false, error: `File is empty: ${args.path}` }, 1);
  if (st.size > MAX_BYTES) {
    emit({ ok: false, error: `File exceeds ${MAX_BYTES} byte cap (got ${st.size}).` }, 1);
  }

  const bytes = new Uint8Array(readFileSync(absolute));
  const mimeType = args.mimeType?.trim() || mimeFromExtension(extname(absolute).toLowerCase());
  const filename = basename(absolute);

  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  const id = randomUUID();
  const ext = extensionFor(mimeType);
  writeFileSync(join(uploadsDir, `${id}.${ext}`), bytes);
  const manifest = {
    id,
    mimeType,
    filename,
    size: bytes.length,
    createdAt: new Date().toISOString()
  };
  writeFileSync(join(uploadsDir, `${id}.json`), JSON.stringify(manifest));

  emit({ ok: true, uploadId: id, mimeType, size: bytes.length, filename });
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
