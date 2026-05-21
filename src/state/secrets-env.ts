// Shared writer for ~/.gini/secrets.env.
//
// Two call sites historically reimplemented the same logic with subtle
// drift:
//   - src/cli/commands/setup.ts (writeKeyToSecretsFile) — the original
//     CLI-side helper used by `gini setup`, `gini provider set`, etc.
//   - src/runtime/setup-api.ts — the browser /setup endpoint POST that
//     persists the key the user typed into the form.
//
// Both must produce a shell-sourceable file (the installed `gini` wrapper
// does `set -a; . ~/.gini/secrets.env; set +a`), and both must end up at
// mode 0600 even if a previous version of the file existed at 0644.
//
// Lives under src/state/ because secrets.env is local persistent state —
// not provider behavior, not a CLI concern. Both runtime and CLI are
// allowed to import from src/state/.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Resolve via process.env.HOME first so test seams that override the env
// var see the override. os.homedir() caches the platform's getpwuid
// result on macOS and won't pick up a runtime HOME change.
export function secretsEnvPath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".gini", "secrets.env");
}

// POSIX-safe single-quote escaping. Closes the literal string, inserts an
// escaped quote, reopens. The single-quoted shell form is fully literal —
// `$`, backticks, and backslashes pass through unchanged. The result of
// `parseSecretsEnv` (in src/cli/autostart.ts) inverts this exact form.
function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// Write a `KEY=value` (or replace an existing one) into ~/.gini/secrets.env
// in a shell-sourceable form. Always lands at mode 0600 — even when the
// file pre-existed at a more permissive mode.
//
// Idempotency: matches `export NAME=...` and bare `NAME=...` forms (set -a
// exports either, so accepting both keeps us compatible with hand-edited
// files).
//
// `writeFileSync`'s `mode` option only applies on file CREATION. If the
// file pre-existed with 0644 (e.g. a user hand-edited it), the write
// keeps that permission. Explicit chmod after the write ensures 0600 on
// every call so secrets aren't world-readable.
export function writeKeyToSecretsEnv(name: string, value: string): void {
  const path = secretsEnvPath();
  // mkdir if missing — secrets.env may be the first file we ever write
  // here on a fresh install.
  mkdirSync(dirname(path), { recursive: true });
  let existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `export ${name}=${shellSingleQuote(value)}`;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}=.*$`, "m");
  if (pattern.test(existing)) {
    existing = existing.replace(pattern, line);
  } else {
    if (existing && !existing.endsWith("\n")) existing += "\n";
    existing += line + "\n";
  }
  writeFileSync(path, existing, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort tightening */ }
}

// Best-effort permission-tightening for the existing file. No-op when the
// file doesn't exist. Kept as a separate helper so callers that just want
// to enforce mode 0600 (e.g. before reading secrets) don't have to write
// a new key.
export function ensureSecretsEnvPerms(): void {
  const path = secretsEnvPath();
  if (!existsSync(path)) return;
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

// Undo the single-quote escaping written by writeKeyToSecretsEnv. Inverse
// of the POSIX ANSI-C quoting the writer uses; also accepts double-quoted
// values for compatibility with hand-edited files. Exported so the CLI's
// readback (`gini setup` / `gini provider set`) and the autostart plist
// installer share one implementation instead of three subtly different
// ones.
export function unquoteSecretsValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return trimmed;
}

// Predicate: does ~/.gini/secrets.env already carry a NON-EMPTY value
// for this env-var name? Used by callers that want to avoid silently
// clobbering an existing key — `gini import apply openclaw` notably
// wants to skip a provider key the operator has already configured,
// unless --force is set, since the openclaw value may be stale or
// wrong.
//
// "Has key" means there is a `KEY=value` line AND the value (after
// unquoting) is non-empty. An entry like `OPENAI_API_KEY=""` is
// treated as MISSING — the operator either set up a placeholder
// before configuring or hand-cleared a stale value, and the migrator
// should fill it instead of treating the placeholder as a real key.
// This matches `hasKeyInSecretsFile` in `src/cli/commands/setup.ts`,
// so `gini setup` and `gini import apply openclaw` agree on what
// counts as "the operator has configured this key."
export function secretsEnvHasKey(name: string): boolean {
  const path = secretsEnvPath();
  if (!existsSync(path)) return false;
  const contents = readFileSync(path, "utf8");
  const match = new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`, "m").exec(contents);
  if (!match) return false;
  return unquoteSecretsValue(match[1] ?? "").length > 0;
}
