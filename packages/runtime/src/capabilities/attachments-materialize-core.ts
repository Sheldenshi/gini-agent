// Core upload materialization. Writes a Gini upload's bytes to a stable
// per-upload path inside the agent's workspace so terminal_exec / code_exec
// / git flows can use the file, and so the chat-attachment delivery path can
// always hand the model an on-disk path regardless of provider modality.
//
// The materialize skill (skills/attachments/scripts/materialize.ts) is the
// agent-initiated entry point with its own configurable-destination
// contract; this is the in-core entry point the chat path calls directly.
// Both share the workspace-escape guard in ./workspace-write.

import { existsSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { RuntimeConfig } from "../types";
import { readUpload, sanitizeFilename, extensionFor } from "../state/uploads";
import { assertInsideWorkspaceNoSymlinkEscape } from "../state";
import { writeInsideWorkspace } from "./workspace-write";

export interface MaterializedUpload {
  // Workspace-relative path (e.g. "uploads/<id>/report.pdf").
  path: string;
  // Absolute on-disk path.
  absPath: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MaterializeUploadOptions {
  // Reserved for future callers (e.g. an alternate destination subdir).
  // Kept minimal per Simplicity First — nothing speculative is wired yet.
}

// Reduce a (possibly already-sanitized) manifest filename to a single safe
// path segment: drop any directory components, then keep only
// [A-Za-z0-9._-] and strip leading dots. Returns "" when nothing usable
// remains so the caller can fall back to `<id>.<ext>`.
function safeSegment(name: string): string {
  const base = basename(sanitizeFilename(name)).replace(/[/\\]/g, "");
  return base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
}

// True when an already-existing destination resolves (through any symlinks on
// its path) to a location inside the workspace. The escape guard throws on a
// symlink that walks out of the workspace, so a false return means the fast
// path must not trust the existing file — the caller rewrites through the
// guarded write, which rejects the escape.
function existingPathIsSafe(workspaceRoot: string, dest: string): boolean {
  try {
    assertInsideWorkspaceNoSymlinkEscape(workspaceRoot, dest);
    return true;
  } catch {
    return false;
  }
}

// Write the upload's bytes to `<workspaceRoot>/uploads/<id>/<name>` and
// return its metadata. Idempotent: if the destination already exists with
// the same byte length, skip the rewrite. Returns null when the upload
// doesn't exist.
export function materializeUpload(
  config: RuntimeConfig,
  uploadId: string,
  _opts: MaterializeUploadOptions = {}
): MaterializedUpload | null {
  const upload = readUpload(config.instance, uploadId);
  if (!upload) return null;

  const name = safeSegment(upload.filename ?? "") || `${uploadId}.${extensionFor(upload.mimeType)}`;
  const dest = join("uploads", uploadId, name);
  const expectedAbs = join(config.workspaceRoot, dest);

  // Write-if-missing: only write when absent or a stale partial (different
  // size). Upload bytes are immutable for a given id, so a same-size file is
  // treated as already materialized. The skip-rewrite optimization only holds
  // when the existing destination resolves safely inside the workspace — a
  // same-size symlink pointing outside would otherwise be returned and later
  // read through, escaping the workspace. When the guard rejects, fall through
  // to writeInsideWorkspace, which re-runs the symlink walk and throws.
  let absPath: string;
  if (
    existsSync(expectedAbs) &&
    Bun.file(expectedAbs).size === upload.bytes.length &&
    existingPathIsSafe(config.workspaceRoot, dest)
  ) {
    absPath = expectedAbs;
  } else {
    absPath = writeInsideWorkspace(config.workspaceRoot, dest, upload.bytes);
  }

  return {
    path: relative(config.workspaceRoot, absPath),
    absPath,
    filename: name,
    mimeType: upload.mimeType,
    size: upload.bytes.length
  };
}
