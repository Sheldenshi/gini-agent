// Workspace-escape-guarded file write, used by the materialize skill script.
//
// Deliberate copy of packages/runtime/src/capabilities/workspace-write.ts:
// skill scripts must stay self-contained (no runtime-source imports) so the
// skill stays portable. If you change the guard logic, change BOTH copies —
// each carries this pointer and its own test suite pins the behavior.
//
// Two layers of protection:
//   1. Lexical: the destination must normalize to a path inside the
//      workspace root (reject `..` traversal, absolute paths outside root).
//   2. Symlink: the lexical guard can't see symlinks, so walk each path
//      component from the root down, lstat-ing (NOT following) each, and
//      reject any symlink — dangling or live — before creating or writing
//      anything, so a symlink can't redirect a write or an mkdir outside
//      the workspace.

import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export class WorkspaceEscapeError extends Error {}

// Resolve `target` (absolute or workspace-relative) to an absolute path and
// assert it stays inside `workspaceRoot`. Throws WorkspaceEscapeError on
// escape.
export function assertInsideWorkspace(workspaceRoot: string, target: string): string {
  const root = normalize(workspaceRoot);
  if (isAbsolute(target)) {
    const normalized = normalize(target);
    if (normalized !== root && !normalized.startsWith(`${root}${sep}`)) {
      throw new WorkspaceEscapeError(`Path outside workspace: ${target}`);
    }
    return normalized;
  }
  const candidate = normalize(resolve(workspaceRoot, target));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new WorkspaceEscapeError(`Path outside workspace: ${target}`);
  }
  // Confirm the relative computation doesn't reveal an escape.
  const rel = relative(root, candidate);
  if (rel.startsWith("..")) {
    throw new WorkspaceEscapeError(`Path outside workspace: ${target}`);
  }
  return candidate;
}

// Walk each path component from the workspace root down, lstat-ing (NOT
// following) each. Reject any symlink — dangling or live, at the
// destination or an intermediate dir — before any mkdir/write so a symlink
// can't redirect the write outside the workspace. A missing component means
// everything below it is created fresh under a real in-workspace dir, so
// stop walking there.
export function assertNoSymlinkOnPath(workspaceRoot: string, absolute: string): void {
  const root = normalize(workspaceRoot);
  const relParts = relative(root, absolute).split(sep).filter(Boolean);
  let cur = root;
  for (const part of relParts) {
    cur = join(cur, part);
    let ls;
    try {
      ls = lstatSync(cur);
    } catch {
      break;
    }
    if (ls.isSymbolicLink()) {
      throw new WorkspaceEscapeError(`Path contains a symlink: ${absolute}`);
    }
  }
}

// Escape-guarded write: resolve `dest` (relative or absolute) inside
// `workspaceRoot`, reject symlinked components, create parent dirs, and
// write `bytes`. Returns the absolute destination. Throws
// WorkspaceEscapeError if the destination would escape the workspace.
export function writeInsideWorkspace(
  workspaceRoot: string,
  dest: string,
  bytes: Uint8Array
): string {
  const absolute = assertInsideWorkspace(workspaceRoot, dest);
  assertNoSymlinkOnPath(workspaceRoot, absolute);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
  return absolute;
}
