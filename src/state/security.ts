import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export function assertInsideWorkspace(workspaceRoot: string, targetPath: string): string {
  const workspace = resolve(workspaceRoot);
  const target = resolve(workspaceRoot, targetPath);
  const rel = relative(workspace, target);
  if (rel.startsWith("..")) {
    throw new Error(`Path is outside workspace: ${targetPath}`);
  }
  return target;
}

// Lexical check + realpath validation of the deepest existing ancestor.
// `assertInsideWorkspace` only resolves paths textually, so a symlink
// inside the workspace pointing outside (e.g. `workspace/escape ->
// /tmp/outside`) lets a model-issued write to `escape/foo.txt` land at
// `/tmp/outside/foo.txt`. Used for write-style operations (file.write,
// file.patch) where the gap can land bytes outside the workspace; the
// read-style callers can keep using the cheaper `assertInsideWorkspace`
// because reading-through-symlinks is the existing intentional behavior
// for those tools. Mirrors `resolveUploadPath` in `src/tools/browser.ts`.
export function assertInsideWorkspaceNoSymlinkEscape(workspaceRoot: string, targetPath: string): string {
  const target = assertInsideWorkspace(workspaceRoot, targetPath);
  const realWorkspace = realpathSync(resolve(workspaceRoot));
  // Walk up until we find an existing ancestor of `target`. Newly-being-
  // created directories won't realpath, so we anchor the check on the
  // closest existing parent.
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = existsSync(probe) ? realpathSync(probe) : probe;
  const rel = relative(realWorkspace, realProbe);
  // An empty `rel` means the probe IS the workspace root — allowed.
  // A leading `..` means we walked out of the workspace via a symlink.
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error(`Path escapes workspace via symlink: ${targetPath}`);
  }
  return target;
}

export function hashSecret(value: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(value).digest("hex");
  return `sha256:${digest}`;
}

export function randomPairingCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((value) => String(value % 10))
    .join("")
    .replace(/^(.{3})(.{3})$/, "$1-$2");
}
