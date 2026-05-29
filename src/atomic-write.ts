import { closeSync, fsyncSync, openSync, renameSync, writeSync, unlinkSync } from "node:fs";
import { dirname, basename } from "node:path";

// Atomic config write: write to a sibling tempfile in the same directory,
// fsync the data, then rename(2). Reads tolerate transient ENOENT or partial
// parse via one retry — see docs/adr/tunnel-and-mobile-access.md
// "Architecture (summary)".
export function atomicWriteFile(path: string, contents: string): void {
  const dir = dirname(path);
  const tmp = `${dir}/.${basename(path)}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}
