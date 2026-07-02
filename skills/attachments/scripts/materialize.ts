#!/usr/bin/env bun
// materialize skill script.
//
// Contract:
//   stdin:  JSON { uploadId, path? }
//   env:    GINI_WORKSPACE, GINI_UPLOADS_DIR
//   stdout: JSON { ok, path?, absPath?, mimeType?, size?, filename?, error? }
//   exit:   0 on success, 1 on hard failure
//
// Inverse of promote-file: write a Gini upload's bytes to a workspace
// file. Closes the chat-attached-bytes gap: chat images live only as
// upload-id markers; this lands them on disk so terminal_exec / code_exec
// / git flows (e.g. committing an image to an asset branch) can use them.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, normalize, relative } from "node:path";
import {
  WorkspaceEscapeError,
  assertInsideWorkspace,
  writeInsideWorkspace
} from "./workspace-write";

interface Args {
  uploadId: string;
  path?: string;
}

interface Result {
  ok: boolean;
  path?: string;
  absPath?: string;
  mimeType?: string;
  size?: number;
  filename?: string;
  error?: string;
}

interface UploadManifest {
  id: string;
  mimeType: string;
  filename?: string;
  size: number;
  createdAt: string;
}

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

// `uploadId` is interpolated into filesystem paths, so it must be an
// opaque basename (real uploads are crypto.randomUUID()). Reject anything
// that could traverse out of GINI_UPLOADS_DIR before any path use.
function isSafeUploadId(uploadId: string): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(uploadId)) return false;
  return !uploadId.split("/").includes("..") && uploadId !== "..";
}

// Resolve the blob the core store wrote for this upload. The store names
// the blob `<id>.<ext>` with an ext derived from the mimeType by a map we
// don't share (src/state/uploads.ts), so we find the bytes by listing the
// uploads dir for the single sibling that starts with `<id>.` and isn't the
// `<id>.json` manifest. This stays correct no matter which writer (chat
// drop-zone, signed-download, promote-file) created the upload.
function resolveBlob(uploadsDir: string, uploadId: string): string | null {
  const prefix = `${uploadId}.`;
  const manifestName = `${uploadId}.json`;
  const matches = readdirSync(uploadsDir).filter(
    (name) => name.startsWith(prefix) && name !== manifestName
  );
  if (matches.length !== 1) return null;
  return join(uploadsDir, matches[0]);
}

// Strip directory components and characters that would let a manifest
// filename redirect the default destination. The result is a bare basename
// that lands at the workspace root.
function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[/\\]/g, "");
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "";
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
  if (!args.uploadId) emit({ ok: false, error: "uploadId is required." }, 1);
  if (!isSafeUploadId(args.uploadId)) emit({ ok: false, error: "Invalid uploadId." }, 1);

  const manifestPath = join(uploadsDir, `${args.uploadId}.json`);
  if (!existsSync(manifestPath)) emit({ ok: false, error: `Upload not found: ${args.uploadId}` }, 1);
  let manifest: UploadManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as UploadManifest;
  } catch (error) {
    emit({ ok: false, error: `Bad upload manifest: ${error instanceof Error ? error.message : String(error)}` }, 1);
  }

  const blobPath = resolveBlob(uploadsDir, args.uploadId);
  if (!blobPath) emit({ ok: false, error: `Upload bytes not found: ${args.uploadId}` }, 1);
  const bytes = new Uint8Array(readFileSync(blobPath));

  const dest = args.path?.trim()
    || sanitizeFilename(manifest.filename ?? "")
    || basename(blobPath);

  // The shared guard asserts the destination stays inside the workspace
  // (lexically), rejects any symlinked path component, creates parent dirs,
  // and writes — so a symlink can't redirect the write outside the
  // workspace. WorkspaceEscapeError surfaces as a hard failure.
  let absolute: string;
  try {
    absolute = writeInsideWorkspace(workspace, dest, bytes);
  } catch (error) {
    if (error instanceof WorkspaceEscapeError) {
      emit({ ok: false, error: error.message }, 1);
    }
    emit({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1);
  }

  emit({
    ok: true,
    path: relative(normalize(workspace), absolute),
    absPath: absolute,
    mimeType: manifest.mimeType,
    size: bytes.length,
    filename: manifest.filename
  });
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
