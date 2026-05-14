// Filesystem skill loader.
//
// Walks two roots looking for `SKILL.md` files (Hermes-compatible shape):
//   - bundled: <repo-root>/skills/<category>/<skill>/SKILL.md (vendored,
//     ships with the runtime — apple-notes, apple-reminders, …)
//   - user:    ~/.gini/instances/<instance>/skills/<skill>/SKILL.md or
//              ~/.gini/instances/<instance>/skills/<category>/<skill>/SKILL.md
//
// Each file has YAML-ish frontmatter (name, description, version,
// platforms, prerequisites, …) followed by a markdown body that teaches
// the LLM how to use the skill. The loader parses both, upserts a
// SkillRecord into runtime state (matching by `name`), and bumps `version`
// when the file content changes. User-set fields (status — e.g. trusted /
// disabled) are preserved so re-running the loader doesn't reset trust
// decisions.
//
// Skills whose `platforms` doesn't include the host platform are skipped;
// the LoadReport surfaces the reason so users can see why a skill wasn't
// loaded.
//
// We don't depend on a real YAML parser — frontmatter is intentionally
// limited to the subset Hermes ships (string scalars, simple `[a, b]`
// inline arrays, two levels of nesting). That keeps the loader dependency-
// free and fast at boot.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { RuntimeConfig, RuntimeState, SkillRecord, SkillStatus } from "../types";
import { addAudit, appendEvent, createSkill, mutateState, now } from "../state";
import { projectRoot, skillsDir } from "../paths";

export interface ParsedSkillFile {
  name: string;
  description: string;
  version: string;
  platforms?: string[];
  prerequisites?: { commands?: string[]; env?: string[] };
  requiredIdentities?: Array<{ kind: string; scopes?: string[] }>;
  body: string;
  // Original frontmatter for traceability. Loader doesn't read these
  // beyond the keys above, but we keep the whole map so future passes can
  // surface metadata.hermes tags without a re-parse.
  frontmatter: Record<string, unknown>;
}

export interface SkillLoadResult {
  added: SkillRecord[];
  updated: SkillRecord[];
  skipped: Array<{ name: string; reason: string; path?: string }>;
}

interface DiscoveredSkill {
  manifestPath: string;
  category?: string;
  source: "bundled" | "user";
}

// Walk a root looking for `SKILL.md` files. Each directory may either be
// `<root>/<skill>/SKILL.md` (no category) or `<root>/<category>/<skill>/SKILL.md`.
// Returns whichever entries exist; missing roots are silently skipped so a
// fresh user instance without skills/ doesn't error.
function discoverSkillFiles(root: string, source: "bundled" | "user"): DiscoveredSkill[] {
  if (!existsSync(root)) return [];
  const out: DiscoveredSkill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const directManifest = join(dir, "SKILL.md");
    if (existsSync(directManifest)) {
      out.push({ manifestPath: directManifest, source });
      continue;
    }
    // Walk one more level for the category/skill layout.
    let nested: string[];
    try {
      nested = readdirSync(dir);
    } catch {
      continue;
    }
    for (const child of nested) {
      const childDir = join(dir, child);
      let childStat;
      try {
        childStat = statSync(childDir);
      } catch {
        continue;
      }
      if (!childStat.isDirectory()) continue;
      const manifest = join(childDir, "SKILL.md");
      if (existsSync(manifest)) {
        out.push({ manifestPath: manifest, category: entry, source });
      }
    }
  }
  return out;
}

// Split a SKILL.md file into (frontmatter, body). Frontmatter is the
// YAML-ish block between two `---` lines at the top; if missing, returns
// the whole file as body and an empty frontmatter map.
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter: "", body: normalized };
  const after = normalized.slice(3);
  // Tolerate "---\n" or "---<CR>". Find the closing `---` on its own line.
  const closeMatch = after.match(/^([\s\S]*?)\n---\s*\n?/);
  if (!closeMatch) return { frontmatter: "", body: normalized };
  const frontmatter = closeMatch[1] ?? "";
  const body = after.slice(closeMatch[0].length);
  // Trim a leading newline from frontmatter if present.
  return { frontmatter: frontmatter.replace(/^\n/, ""), body };
}

// Tiny YAML-ish parser. Supports the subset of Hermes-style frontmatter:
//   key: scalar
//   key: "scalar with spaces"
//   key: [a, b, c]                  (inline arrays)
//   key:                            (nested map; child indented by 2 spaces)
//     subkey: value
//     subkey: [a, b]
//   key:                            (list of maps)
//     - subkey: value
//       other: value
//   key:                            (list of scalars)
//     - foo
//     - bar
// Comments (`# …`) are dropped. Booleans / numbers / quoted strings are
// returned as JS values; unquoted strings stay as-is.
type Container = Record<string, unknown> | unknown[];
interface Frame { indent: number; container: Container }

export function parseFrontmatter(text: string): Record<string, unknown> {
  const lines = text.split("\n");
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ indent: -1, container: root }];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const raw = lines[lineIdx]!;
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^(\s*)/)?.[1]?.length ?? 0;
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const line = raw.slice(indent);
    const top = stack[stack.length - 1]!;

    // List item: `- value` (scalar) or `- key: value` (start of a map).
    if (line.startsWith("- ") || line === "-") {
      const arr = top.container as unknown[];
      if (!Array.isArray(arr)) continue;
      const rest = line.slice(1).trim();
      if (!rest) {
        const child: Record<string, unknown> = {};
        arr.push(child);
        stack.push({ indent: indent + 2, container: child });
        continue;
      }
      const colonIdx = rest.indexOf(":");
      if (colonIdx < 0) {
        arr.push(parseScalarOrInlineArray(rest));
        continue;
      }
      // `- key: value` starts a new map element with the key already set.
      const child: Record<string, unknown> = {};
      const subKey = rest.slice(0, colonIdx).trim();
      const subRest = rest.slice(colonIdx + 1).trim();
      if (subRest) child[subKey] = parseScalarOrInlineArray(subRest);
      arr.push(child);
      stack.push({ indent: indent + 2, container: child });
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    if (Array.isArray(top.container)) continue;
    const container = top.container as Record<string, unknown>;
    if (!rest) {
      // Decide map vs list by looking ahead for the first indented item.
      const child: Container = nextChildContainer(lines, lineIdx, indent);
      container[key] = child;
      stack.push({ indent, container: child });
      continue;
    }
    container[key] = parseScalarOrInlineArray(rest);
  }

  return root;
}

function nextChildContainer(lines: string[], startIndex: number, parentIndent: number): Container {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const value = lines[index]!;
    if (!value.trim() || value.trim().startsWith("#")) continue;
    const indent = value.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent <= parentIndent) return {};
    const rest = value.slice(indent);
    if (rest.startsWith("- ") || rest === "-") return [];
    return {};
  }
  return {};
}

function parseScalarOrInlineArray(value: string): unknown {
  const trimmed = stripInlineComment(value).trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseScalar(part.trim()));
  }
  return parseScalar(trimmed);
}

function stripInlineComment(value: string): string {
  // Strip ` # comment` at end of line, but only outside quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
      return value.slice(0, i);
    }
  }
  return value;
}

function parseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseSkillFile(text: string): ParsedSkillFile {
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = parseFrontmatter(frontmatter);
  const name = typeof fm.name === "string" ? fm.name : "";
  const description = typeof fm.description === "string" ? fm.description : "";
  const version = fm.version === undefined ? "1.0.0" : String(fm.version);
  const platforms = Array.isArray(fm.platforms) ? fm.platforms.map(String) : undefined;
  let prerequisites: ParsedSkillFile["prerequisites"];
  if (fm.prerequisites && typeof fm.prerequisites === "object" && !Array.isArray(fm.prerequisites)) {
    const pre = fm.prerequisites as Record<string, unknown>;
    prerequisites = {
      commands: Array.isArray(pre.commands) ? pre.commands.map(String) : undefined,
      env: Array.isArray(pre.env) ? pre.env.map(String) : undefined
    };
  }
  let requiredIdentities: ParsedSkillFile["requiredIdentities"];
  if (fm.requires && typeof fm.requires === "object" && !Array.isArray(fm.requires)) {
    const reqs = fm.requires as Record<string, unknown>;
    if (Array.isArray(reqs.identities)) {
      const collected: Array<{ kind: string; scopes?: string[] }> = [];
      for (const entry of reqs.identities) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const item = entry as Record<string, unknown>;
        const kind = typeof item.kind === "string" ? item.kind : "";
        if (!kind) continue;
        const scopes = Array.isArray(item.scopes) ? item.scopes.map(String) : undefined;
        collected.push(scopes ? { kind, scopes } : { kind });
      }
      requiredIdentities = collected;
    }
  }
  return {
    name,
    description,
    version,
    platforms,
    prerequisites,
    requiredIdentities,
    body: body.trim(),
    frontmatter: fm
  };
}

// Map host platform → frontmatter platform tag. Frontmatter uses Hermes
// names (macos, linux, windows) which differ from process.platform.
function hostPlatformTag(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  return process.platform;
}

function platformAllowed(platforms: string[] | undefined): boolean {
  if (!platforms || platforms.length === 0) return true;
  return platforms.includes(hostPlatformTag());
}

// Public for tests. Compute the bundled skills root for the running
// process. We resolve from projectRoot() (which uses import.meta.dir to
// find the repo root) and append `skills/`. Tests can override via
// GINI_BUNDLED_SKILLS.
export function bundledSkillsRoot(): string {
  if (process.env.GINI_BUNDLED_SKILLS) return resolve(process.env.GINI_BUNDLED_SKILLS);
  return join(projectRoot(), "skills");
}

// Apply parsed file to the runtime state. Matches an existing skill by
// (name, source) — bundled and user-instance skills with the same name
// are kept as separate rows so a user-instance SKILL.md cannot hijack the
// trust grant of a vendored bundled skill (see Review P1 #1). Preserves
// user-managed fields (`tests`, success/failure counts, previousVersions,
// lastUsedAt, and explicit disabled/archived status). Existing bundled records
// left as draft by older loader versions are promoted to trusted on reload.
// On match: only bump the numeric version when the content changed. On miss:
// create bundled Gini skills with status="trusted" and user-instance skills
// with status="draft".
function upsertSkillFromFile(
  state: RuntimeState,
  parsed: ParsedSkillFile,
  origin: DiscoveredSkill
): { record: SkillRecord; kind: "added" | "updated" | "noop" } {
  // Match on (name, source). Legacy records (created before `source` was
  // added) default to "user" via normalizeState, so bundled re-loads will
  // create a separate row for the bundled flavor on the first pass —
  // intentional, because we have no way to retroactively know the original
  // origin for legacy rows.
  const existing = state.skills.find(
    (skill) => skill.name === parsed.name && (skill.source ?? "user") === origin.source
  );
  const trimmedBody = parsed.body;
  const at = now();

  if (existing) {
    const changed =
      existing.body !== trimmedBody ||
      existing.description !== parsed.description ||
      existing.manifestPath !== origin.manifestPath ||
      existing.category !== origin.category ||
      JSON.stringify(existing.platforms ?? null) !== JSON.stringify(parsed.platforms ?? null) ||
      JSON.stringify(existing.prerequisites ?? null) !== JSON.stringify(parsed.prerequisites ?? null) ||
      JSON.stringify(existing.requiredIdentities ?? null) !== JSON.stringify(parsed.requiredIdentities ?? null);
    const promoteBundledDraft = origin.source === "bundled" && existing.status === "draft";
    if (!changed && !promoteBundledDraft) return { record: existing, kind: "noop" };
    if (changed) {
      existing.previousVersions.unshift({
        version: existing.version,
        updatedAt: existing.updatedAt,
        description: existing.description,
        trigger: existing.trigger,
        steps: existing.steps,
        requiredTools: existing.requiredTools,
        requiredPermissions: existing.requiredPermissions
      });
      existing.description = parsed.description;
      existing.body = trimmedBody;
      existing.manifestPath = origin.manifestPath;
      existing.category = origin.category;
      existing.platforms = parsed.platforms;
      existing.prerequisites = parsed.prerequisites;
      existing.requiredIdentities = parsed.requiredIdentities;
      existing.version += 1;
    }
    if (promoteBundledDraft) existing.status = "trusted";
    existing.updatedAt = at;
    return { record: existing, kind: "updated" };
  }

  const initialStatus: SkillStatus = origin.source === "bundled" ? "trusted" : "draft";
  const record = createSkill(state, {
    name: parsed.name,
    description: parsed.description,
    trigger: "",
    steps: [],
    requiredTools: [],
    requiredPermissions: [],
    status: initialStatus,
    body: trimmedBody,
    manifestPath: origin.manifestPath,
    category: origin.category,
    platforms: parsed.platforms,
    prerequisites: parsed.prerequisites,
    requiredIdentities: parsed.requiredIdentities,
    source: origin.source
  });
  return { record, kind: "added" };
}

// Main entry. Re-runnable (boot + manual /api/skills/reload). Errors on
// individual files are absorbed and reported in `skipped` so a single
// malformed SKILL.md can't take the loader down.
export async function loadSkillsFromDisk(config: RuntimeConfig): Promise<SkillLoadResult> {
  const bundledRoot = bundledSkillsRoot();
  const userRoot = skillsDir(config.instance);
  const discovered = [
    ...discoverSkillFiles(bundledRoot, "bundled"),
    ...discoverSkillFiles(userRoot, "user")
  ];

  return mutateState(config.instance, (state) => {
    const result: SkillLoadResult = { added: [], updated: [], skipped: [] };
    for (const entry of discovered) {
      let parsed: ParsedSkillFile;
      try {
        const raw = readFileSync(entry.manifestPath, "utf8");
        parsed = parseSkillFile(raw);
      } catch (error) {
        result.skipped.push({
          name: basename(dirname(entry.manifestPath)),
          reason: `parse error: ${error instanceof Error ? error.message : String(error)}`,
          path: entry.manifestPath
        });
        continue;
      }
      if (!parsed.name.trim()) {
        result.skipped.push({
          name: basename(dirname(entry.manifestPath)),
          reason: "frontmatter missing required `name` field",
          path: entry.manifestPath
        });
        continue;
      }
      if (!platformAllowed(parsed.platforms)) {
        result.skipped.push({
          name: parsed.name,
          reason: `platforms ${JSON.stringify(parsed.platforms)} excludes ${hostPlatformTag()}`,
          path: entry.manifestPath
        });
        appendEvent(state, {
          kind: "skill",
          action: "skill.skipped",
          target: parsed.name,
          risk: "low",
          summary: `Skipped ${parsed.name}: platform mismatch`,
          data: { platforms: parsed.platforms, host: hostPlatformTag() }
        });
        continue;
      }
      const upsert = upsertSkillFromFile(state, parsed, entry);
      if (upsert.kind === "added") {
        result.added.push(upsert.record);
        addAudit(state, {
          actor: "runtime",
          action: "skill.loaded",
          target: upsert.record.id,
          risk: "low",
          evidence: {
            name: parsed.name,
            source: entry.source,
            manifestPath: entry.manifestPath,
            initialStatus: upsert.record.status
          }
        });
      } else if (upsert.kind === "updated") {
        result.updated.push(upsert.record);
        addAudit(state, {
          actor: "runtime",
          action: "skill.reloaded",
          target: upsert.record.id,
          risk: "low",
          evidence: {
            name: parsed.name,
            source: entry.source,
            manifestPath: entry.manifestPath,
            version: upsert.record.version
          }
        });
      }
    }
    return result;
  });
}
