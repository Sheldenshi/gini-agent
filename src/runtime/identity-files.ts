// Runtime identity files: INSTRUCTIONS.md, SOUL.md, USER.md.
//
// Loads three optional markdown files from the instance directory and
// produces strings the system-prompt assembler can splice straight into
// the prompt. None of the files are mandatory — a missing file returns
// null and the caller falls back to defaults (for INSTRUCTIONS.md) or
// elides the block (for SOUL.md / USER.md).
//
// Trust boundary: all three files are user-controlled content that ends
// up in the system channel of every chat turn. We scan each file against
// a small set of prompt-injection patterns (ported from Hermes' context
// file scanner in agent/prompt_builder.py) before injection. A file that
// trips a pattern is replaced inline with a [BLOCKED: ...] notice; the
// gateway does not crash on a hostile file.
//
// Write path: `edit_soul` and `edit_user_profile` tool handlers route
// here. Agent-proposed edits land at `<file>.proposed`; approval renames
// the proposal over `<file>` atomically. The prompt assembler only reads
// the approved file — proposals never reach the model directly.
//
// See ADR runtime-identity-files.md for the full design.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { instanceRoot } from "../paths";
import { appendLog } from "../state/trace";
import { DEFAULT_GINI_INSTRUCTIONS } from "../system-prompt";
import type { Instance } from "../types";

// ---------------------------------------------------------------------------
// Path helpers. Centralized so future renames touch one place.
// ---------------------------------------------------------------------------

export function instructionsPath(instance: Instance): string {
  return join(instanceRoot(instance), "INSTRUCTIONS.md");
}

export function userProfilePath(instance: Instance): string {
  return join(instanceRoot(instance), "USER.md");
}

export function userProfileProposedPath(instance: Instance): string {
  return `${userProfilePath(instance)}.proposed`;
}

// Per-agent SOUL.md. Lives under a per-agent directory; the directory
// itself is created lazily on first write. Readers tolerate a missing
// directory and treat it as "no SOUL set".
export function agentDir(instance: Instance, agentId: string): string {
  return join(instanceRoot(instance), "agents", agentId);
}

export function soulPath(instance: Instance, agentId: string): string {
  return join(agentDir(instance, agentId), "SOUL.md");
}

export function soulProposedPath(instance: Instance, agentId: string): string {
  return `${soulPath(instance, agentId)}.proposed`;
}

// ---------------------------------------------------------------------------
// Scaffold path. Materializes the three identity files at instance / agent
// creation so users see them on disk before they have anything specific to
// write. INSTRUCTIONS.md is seeded with the current DEFAULT_GINI_INSTRUCTIONS
// content so a user opening the file has a working preamble to edit against;
// the seed has no header comment or other meta text because any byte in the
// file goes verbatim into the system prompt. USER.md and per-agent SOUL.md
// stay zero-byte — no defaults exist for them.
//
// Reads still go through the load-and-scan helpers, which treat a zero-byte
// (or whitespace-only) file as absent and fall back to defaults — so a
// zero-byte USER.md or SOUL.md does not change prompt behavior.
//
// Both helpers are best-effort: any filesystem error is swallowed and
// logged through `appendLog` so a permission glitch can never crash the
// gateway at startup. They never overwrite an existing file.
// ---------------------------------------------------------------------------

// Touch a zero-byte file at `path` if and only if it does not already
// exist. Uses `openSync(..., "wx")` so the create is atomic against a
// concurrent writer racing the existence check (e.g. a user editing the
// file by hand during runtime startup). Returns true when this call
// actually created the file.
function touchIfMissing(path: string): boolean {
  if (existsSync(path)) return false;
  ensureDir(dirname(path));
  // O_CREAT | O_EXCL: fail if the file appeared between the existsSync
  // and the open. We catch EEXIST and treat it as "someone else created
  // it" — which is the same outcome we wanted.
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") return false;
    throw error;
  }
  closeSync(fd);
  return true;
}

// Create a file at `path` seeded with `content` iff it does not already
// exist. Same atomic O_CREAT|O_EXCL semantics as touchIfMissing — a
// concurrent writer that wins the race leaves their content intact and
// this call reports false. Used to seed INSTRUCTIONS.md with the current
// DEFAULT_GINI_INSTRUCTIONS content so a fresh-install user can see what
// the defaults are and edit against them.
function writeIfMissing(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  ensureDir(dirname(path));
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

export interface ScaffoldInstanceResult {
  created: string[];
}

// Materialize INSTRUCTIONS.md and USER.md at the instance root if absent.
// INSTRUCTIONS.md is seeded with DEFAULT_GINI_INSTRUCTIONS; USER.md stays
// zero-byte. Never overwrites. Returns the list of paths created (possibly
// empty). All filesystem errors are caught and logged; the gateway must not
// crash because a placeholder file failed to materialize.
export function scaffoldInstanceIdentityFiles(instance: Instance): ScaffoldInstanceResult {
  const created: string[] = [];
  // INSTRUCTIONS.md gets seeded with the current default rules so the user
  // has a concrete baseline to edit against. The constant itself stays the
  // in-code fallback for callers that run before install() (unit tests,
  // freshly-uninstalled instance) and for the "delete the file to reset"
  // escape hatch.
  const instructionsTarget = instructionsPath(instance);
  try {
    if (writeIfMissing(instructionsTarget, DEFAULT_GINI_INSTRUCTIONS)) {
      created.push(instructionsTarget);
    }
  } catch (error) {
    try {
      appendLog(instance, "identity.scaffold.error", {
        file: "INSTRUCTIONS.md",
        path: instructionsTarget,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // Logging itself failed (state root unwritable etc.). Swallow —
      // scaffolding is purely opportunistic, the load path tolerates
      // missing files.
    }
  }
  // USER.md has no defaults — it's a personal profile the user fills in.
  // Zero-byte placeholder so it's discoverable on disk.
  const userTarget = userProfilePath(instance);
  try {
    if (touchIfMissing(userTarget)) created.push(userTarget);
  } catch (error) {
    try {
      appendLog(instance, "identity.scaffold.error", {
        file: "USER.md",
        path: userTarget,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // See the INSTRUCTIONS.md branch above — best-effort logging only.
    }
  }
  return { created };
}

export interface ScaffoldAgentResult {
  created: string | null;
}

// Touch agents/<agentId>/SOUL.md at the instance root if absent. Never
// overwrites. Returns the created path or null when the file already
// existed (or the touch failed and was logged).
export function scaffoldAgentSoulFile(instance: Instance, agentId: string): ScaffoldAgentResult {
  const path = soulPath(instance, agentId);
  try {
    if (touchIfMissing(path)) return { created: path };
    return { created: null };
  } catch (error) {
    try {
      appendLog(instance, "identity.scaffold.error", {
        file: "SOUL.md",
        agentId,
        path,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // See scaffoldInstanceIdentityFiles — best-effort logging only.
    }
    return { created: null };
  }
}

// ---------------------------------------------------------------------------
// Injection scan. Ported from Hermes' agent/prompt_builder.py.
// ---------------------------------------------------------------------------

interface ThreatPattern {
  pattern: RegExp;
  id: string;
}

// Each entry pairs a regex with a stable id we surface in the BLOCKED
// notice and the audit/trace log. The patterns deliberately mirror Hermes
// so behavior stays comparable; new patterns belong in this list rather
// than in scattered call sites.
const CONTEXT_THREAT_PATTERNS: ThreatPattern[] = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception_hide" },
  { pattern: /system\s+prompt\s+override/i, id: "sys_prompt_override" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: "disregard_rules" },
  { pattern: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, id: "bypass_restrictions" },
  { pattern: /<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, id: "html_comment_injection" },
  { pattern: /<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, id: "hidden_div" },
  { pattern: /translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i, id: "translate_execute" },
  { pattern: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: "exfil_curl" },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, id: "read_secrets" }
];

// Invisible Unicode characters that attackers use to hide payloads from
// human reviewers. We block on presence — there is no legitimate reason
// for any of these to appear in user-curated markdown.
const CONTEXT_INVISIBLE_CHARS = new Set<string>([
  "​", "‌", "‍", "⁠", "﻿",
  "‪", "‫", "‬", "‭", "‮"
]);

export interface InjectionScanResult {
  ok: boolean;
  sanitized: string;
  findings: string[];
}

// Scan `content` for known threats. When clean, returns the original
// content with `ok: true`. When dirty, returns a single-line BLOCKED
// notice the caller can drop straight into the prompt, plus a findings
// list the caller can record in audit / trace.
export function scanForInjection(content: string, filename: string): InjectionScanResult {
  const findings: string[] = [];
  for (const char of CONTEXT_INVISIBLE_CHARS) {
    if (content.includes(char)) {
      const code = char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
      findings.push(`invisible unicode U+${code}`);
    }
  }
  for (const { pattern, id } of CONTEXT_THREAT_PATTERNS) {
    if (pattern.test(content)) findings.push(id);
  }
  if (findings.length === 0) {
    return { ok: true, sanitized: content, findings: [] };
  }
  return {
    ok: false,
    sanitized: `[BLOCKED: ${filename} contained potential prompt injection (${findings.join(", ")}). Content not loaded.]`,
    findings
  };
}

// ---------------------------------------------------------------------------
// Read path. Each loader returns either the scanned content, a BLOCKED
// notice, or null when the file is absent.
// ---------------------------------------------------------------------------

interface LoadOptions {
  // Optional callback invoked when the scan finds threats. Used by the
  // call sites to record an appendTrace warning. Failures inside the
  // hook never propagate — the loader stays best-effort.
  onBlocked?: (filename: string, findings: string[]) => void;
}

function loadAndScan(path: string, displayName: string, opts: LoadOptions | undefined): string | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Unreadable file (permissions, race with concurrent write) — treat
    // as absent. The gateway must not crash on a transient filesystem
    // error in a user-editable file.
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const result = scanForInjection(trimmed, displayName);
  if (!result.ok && opts?.onBlocked) {
    try {
      opts.onBlocked(displayName, result.findings);
    } catch {
      // Hook errors must never break the load.
    }
  }
  return result.sanitized;
}

// INSTRUCTIONS.md — instance-scoped operating rules. Falls back to the
// DEFAULT_GINI_INSTRUCTIONS constant in the system-prompt assembler when
// this returns null.
export function loadInstructions(instance: Instance, opts?: LoadOptions): string | null {
  return loadAndScan(instructionsPath(instance), "INSTRUCTIONS.md", opts);
}

// SOUL.md — per-agent persona. Returns null when no active agent or no
// file is present; callers elide the block in that case.
export function loadSoul(instance: Instance, agentId: string | undefined, opts?: LoadOptions): string | null {
  if (!agentId) return null;
  return loadAndScan(soulPath(instance, agentId), "SOUL.md", opts);
}

// USER.md — instance-scoped user profile.
export function loadUserProfile(instance: Instance, opts?: LoadOptions): string | null {
  return loadAndScan(userProfilePath(instance), "USER.md", opts);
}

// ---------------------------------------------------------------------------
// Write path. Used by edit_soul / edit_user_profile and by the approval
// API to promote a proposal to the approved file.
// ---------------------------------------------------------------------------

export type IdentityFileStatus = "proposed" | "approved";

export interface IdentityFileWriteResult {
  // Final path written. For status: "proposed" this is `<file>.proposed`;
  // for status: "approved" this is `<file>`.
  path: string;
  status: IdentityFileStatus;
  // Whether the write blew through the injection scan. We always write —
  // the proposed-file gate is what keeps a hostile body out of the
  // prompt — but the caller can record the result for audit visibility.
  scanFindings: string[];
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeFileSafe(path: string, content: string): void {
  ensureDir(dirname(path));
  // Write through a sibling temp file so a crash mid-write cannot leave
  // a half-written file in place of either the proposed or approved
  // target. Matches the pattern state/store.ts uses for state.json.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function writeIdentityFile(
  targetApproved: string,
  targetProposed: string,
  content: string,
  status: IdentityFileStatus,
  displayName: string
): IdentityFileWriteResult {
  const scan = scanForInjection(content, displayName);
  const path = status === "approved" ? targetApproved : targetProposed;
  writeFileSafe(path, content);
  return { path, status, scanFindings: scan.findings };
}

export function writeSoul(
  instance: Instance,
  agentId: string,
  content: string,
  status: IdentityFileStatus
): IdentityFileWriteResult {
  return writeIdentityFile(
    soulPath(instance, agentId),
    soulProposedPath(instance, agentId),
    content,
    status,
    "SOUL.md"
  );
}

export function writeUserProfile(
  instance: Instance,
  content: string,
  status: IdentityFileStatus
): IdentityFileWriteResult {
  return writeIdentityFile(
    userProfilePath(instance),
    userProfileProposedPath(instance),
    content,
    status,
    "USER.md"
  );
}

// Promote a proposed file over the approved file in one atomic step.
// Returns true when a proposal existed and was promoted; false when no
// proposal was found (no-op).
export function approveSoul(instance: Instance, agentId: string): boolean {
  return promote(soulProposedPath(instance, agentId), soulPath(instance, agentId));
}

export function approveUserProfile(instance: Instance): boolean {
  return promote(userProfileProposedPath(instance), userProfilePath(instance));
}

function promote(proposedPath: string, approvedPath: string): boolean {
  if (!existsSync(proposedPath)) return false;
  ensureDir(dirname(approvedPath));
  renameSync(proposedPath, approvedPath);
  return true;
}

// ---------------------------------------------------------------------------
// Remove path. Drop a paragraph (block delimited by blank lines) that
// contains a substring from the approved file body. Writes the result
// through the same propose/approve gate as `writeSoul` / `writeUserProfile`,
// so a remove never reaches the prompt until the user approves it.
// ---------------------------------------------------------------------------

// Discriminated success/failure result. On success the caller gets the
// usual write result (path + status + scanFindings); on failure the
// reason is enumerated so the dispatch layer can surface a clean message
// to the model instead of guessing at why nothing changed.
export type IdentityFileRemoveResult =
  | ({ ok: true } & IdentityFileWriteResult)
  | { ok: false; reason: "no source" | "no match" };

// Split the body on blank lines, drop the first paragraph that contains
// the needle, and rejoin. The needle match is a plain substring check
// (no regex) so callers don't have to escape user input. A "paragraph"
// is one or more non-blank lines bounded by blank lines or the file
// edges — the same unit the `append` action separates with `\n\n`.
function dropParagraphContaining(body: string, needle: string): { changed: boolean; result: string } {
  if (needle.length === 0) return { changed: false, result: body };
  // Normalize line endings so we can scan paragraph blocks without
  // worrying about CRLF mixed input from a user edit on Windows.
  const normalized = body.replace(/\r\n/g, "\n");
  const paragraphs = normalized.split(/\n{2,}/);
  let dropped = false;
  const kept: string[] = [];
  for (const para of paragraphs) {
    if (!dropped && para.includes(needle)) {
      dropped = true;
      continue;
    }
    kept.push(para);
  }
  if (!dropped) return { changed: false, result: body };
  return { changed: true, result: kept.join("\n\n").trim() };
}

function removeIdentityFileSection(
  approvedPath: string,
  proposedPath: string,
  needle: string,
  status: IdentityFileStatus,
  displayName: string
): IdentityFileRemoveResult {
  if (!existsSync(approvedPath)) {
    return { ok: false, reason: "no source" };
  }
  let raw: string;
  try {
    raw = readFileSync(approvedPath, "utf8");
  } catch {
    // Treat an unreadable approved file the same as a missing one. The
    // gateway must not crash on a transient filesystem error.
    return { ok: false, reason: "no source" };
  }
  const { changed, result } = dropParagraphContaining(raw, needle);
  if (!changed) {
    return { ok: false, reason: "no match" };
  }
  const scan = scanForInjection(result, displayName);
  const targetPath = status === "approved" ? approvedPath : proposedPath;
  writeFileSafe(targetPath, result);
  return { ok: true, path: targetPath, status, scanFindings: scan.findings };
}

export function removeSoulSection(
  instance: Instance,
  agentId: string,
  needle: string,
  status: IdentityFileStatus
): IdentityFileRemoveResult {
  return removeIdentityFileSection(
    soulPath(instance, agentId),
    soulProposedPath(instance, agentId),
    needle,
    status,
    "SOUL.md"
  );
}

export function removeUserProfileSection(
  instance: Instance,
  needle: string,
  status: IdentityFileStatus
): IdentityFileRemoveResult {
  return removeIdentityFileSection(
    userProfilePath(instance),
    userProfileProposedPath(instance),
    needle,
    status,
    "USER.md"
  );
}
