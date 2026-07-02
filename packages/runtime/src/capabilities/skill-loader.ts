// Filesystem skill loader.
//
// Walks two roots looking for `SKILL.md` files (Hermes-compatible shape):
//   - bundled: <repo-root>/skills/<category>/<skill>/SKILL.md (vendored,
//     ships with the runtime — apple-notes, apple-reminders, …)
//   - user:    ~/.gini/instances/<instance>/skills/<skill>/SKILL.md
//
// Installs always write user skills flat (no category subfolder). The
// walker still tolerates a `<category>/<skill>/` layout under the user
// root for manually-placed or legacy folders, deriving the category from
// the parent directory name in either case.
//
// Each file has YAML-ish frontmatter (name, description, version,
// platforms, prerequisites, …) followed by a markdown body that teaches
// the LLM how to use the skill. The loader parses both, upserts a
// SkillRecord into runtime state (matching by `name`), and bumps `version`
// when the file content changes. User-set fields (status — enabled,
// disabled, archived) are preserved so re-running the loader doesn't reset
// the operator's enablement decision.
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
import { canonicalCredentialName, hasProvider } from "../integrations/connectors/registry";

export interface ParsedSkillFile {
  name: string;
  description: string;
  version: string;
  platforms?: string[];
  prerequisites?: { commands?: string[]; env?: string[] };
  requiredConnectors?: Array<{ provider: string; scopes?: string[] }>;
  // Frontmatter `metadata.gini.requires.credentials` — credential NAMES the
  // skill needs (e.g. ["LINEAR_API_KEY"], ["google-workspace-oauth"]). A name
  // is resolved against a ConnectorRecord with that `name`, not a provider
  // module, so it need NOT be a registered provider.
  requiredCredentials?: string[];
  // Frontmatter `metadata.gini.requires.approval` — script names that the
  // skill_run dispatch path always gates behind a user Approve/Deny,
  // regardless of approval mode. See ADR skill-script-approval-gating.md.
  requiresApprovalScripts?: string[];
  allowedTools?: string;
  license?: string;
  compatibility?: string;
  validationStatus?: "ok" | "unsupported";
  validationMessage?: string;
  // Advisory frontmatter near-miss warnings (e.g. a top-level `gini:` block,
  // or `requires` misspelled as `requirements`). Distinct from hard
  // validation issues: warnings don't block install, but the credential /
  // connector declaration they flag was silently dropped, so we surface them
  // to the authoring model so it self-corrects.
  warnings?: string[];
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
    //
    // Frame indent for a list-item map is `indent + 1`, NOT `indent + 2`.
    // The pushed frame's `indent` is the "pop threshold" — the next line
    // pops it when `lineIndent <= frame.indent`. Sibling keys inside the
    // same list-item map land at indent + 2 (one indent past the `-`),
    // and they must NOT pop the frame. Using `indent + 1` keeps siblings
    // at `indent + 2` inside the frame while still popping when the next
    // `- ` or higher-level key appears at `indent` or above.
    if (line.startsWith("- ") || line === "-") {
      const arr = top.container as unknown[];
      if (!Array.isArray(arr)) continue;
      const rest = line.slice(1).trim();
      if (!rest) {
        const child: Record<string, unknown> = {};
        arr.push(child);
        stack.push({ indent: indent + 1, container: child });
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
      stack.push({ indent: indent + 1, container: child });
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

// Gini extension keys the loader actually consumes under `metadata.gini`.
// A frontmatter key inside the gini namespace that isn't here is a near-miss
// (typo / wrong shape) whose declaration the loader silently ignored.
const KNOWN_GINI_KEYS = ["version", "author", "platforms", "prerequisites", "requires", "category", "name", "description"];

// Small Levenshtein distance, capped — used only to suggest the nearest known
// gini key for an unrecognized one (e.g. `requirements` → `requires`).
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const temp = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, row[j]!, row[j - 1]!) + 1;
      prev = temp;
    }
  }
  return row[n]!;
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

function nearestKnownGiniKey(key: string): string | undefined {
  const lower = key.toLowerCase();
  // A known key the unrecognized one is clearly an elaboration of — shares a
  // long stem (e.g. `requirements` vs `requires` share `require`). Caught
  // first because such word-form variants exceed a small edit-distance budget.
  let stemMatch: string | undefined;
  let stemLen = 0;
  for (const known of KNOWN_GINI_KEYS) {
    const shared = sharedPrefixLength(lower, known);
    // Require at least 5 shared leading chars and most of the known key, so
    // `requirements`→`requires` matches but unrelated keys don't.
    if (shared >= 5 && shared >= known.length - 2 && shared > stemLen) {
      stemLen = shared;
      stemMatch = known;
    }
  }
  if (stemMatch) return stemMatch;
  // Otherwise the nearest key within edit distance ≤ 2 (transpositions, typos).
  let best: string | undefined;
  let bestDistance = 3;
  for (const known of KNOWN_GINI_KEYS) {
    const distance = editDistance(lower, known);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = known;
    }
  }
  return best;
}

// True when a dropped key's value is an object that carries a `credentials` or
// `connectors` array — i.e. the near-miss silently swallowed a real
// credential/connector declaration, which is the worst-case failure.
function dropsCredentialOrConnector(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.credentials) || Array.isArray(obj.connectors);
}

// Detect frontmatter near-misses in the Gini extension namespace and return
// advisory warnings naming the offending key, the suggested fix, and the
// consequence (declaration ignored). Two near-misses are caught:
//   1. A TOP-LEVEL `gini:` block — the loader only reads `metadata.gini`, so
//      a top-level block is never consumed.
//   2. An unrecognized key inside the gini namespace (e.g. `requirements`
//      misspelled for `requires`), with a near-miss suggestion when within
//      edit distance ≤ 2 of a known key.
// Warnings are advisory: they never block install.
export function detectGiniFrontmatterWarnings(
  fm: Record<string, unknown>,
  giniExt: Record<string, unknown> | null
): string[] {
  const warnings: string[] = [];

  // Identify the "gini-ish" object. metadata.gini is canonical; a top-level
  // `gini:` key is a misplacement the loader doesn't read.
  const topLevelGini = fm.gini && typeof fm.gini === "object" && !Array.isArray(fm.gini)
    ? fm.gini as Record<string, unknown>
    : null;

  let giniObject: Record<string, unknown> | null = giniExt;
  if (!giniExt && topLevelGini) {
    giniObject = topLevelGini;
    warnings.push("Top-level `gini:` block is not read by the loader — Gini fields belong under `metadata.gini`. Move this block to `metadata.gini` so its declarations take effect.");
  }

  if (!giniObject) return warnings;

  for (const key of Object.keys(giniObject)) {
    if (KNOWN_GINI_KEYS.includes(key)) continue;
    const suggestion = nearestKnownGiniKey(key);
    let message = `Unrecognized \`metadata.gini.${key}\` key was ignored`;
    if (suggestion) message += ` — did you mean \`${suggestion}\`?`;
    else message += ".";
    if (dropsCredentialOrConnector(giniObject[key])) {
      message += ` Its \`credentials\`/\`connectors\` declaration was NOT registered; the skill currently has NO credential requirements as written.`;
    }
    warnings.push(message);
  }

  return warnings;
}

// Parse a SKILL.md file per the Anthropic Agent Skills spec
// (https://agentskills.io/specification). Gini-specific extensions live
// under `metadata.gini.*`.
//
// Spec-recognized top-level keys: `name`, `description`, `license`,
// `compatibility`, `metadata`, `allowed-tools`. Frontmatter values outside
// that set are tolerated but ignored.
//
// Gini extension keys (under `metadata.gini`):
//   version, author, platforms,
//   prerequisites: { commands, env },
//   requires: { credentials: [<name>, ...], connectors: [{ provider, scopes? }, ...],
//               approval: [<script name>, ...] }
//
// A skill's category (a UI grouping hint) is NOT read from frontmatter —
// it's derived from the parent directory name in discoverSkillFiles().
// Bundled skills ship under `skills/<category>/<skill>/`; user-installed
// skills land flat under `skills/<skill>/` and so carry no category.
//
// For one release we accept legacy top-level fields (`version`,
// `platforms`, `prerequisites`, `requires.identities` with `kind` keys)
// and log a deprecation warning. Remove the fallback in the release after.
export function parseSkillFile(text: string, sourcePath?: string): ParsedSkillFile {
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = parseFrontmatter(frontmatter);
  const name = typeof fm.name === "string" ? fm.name : "";
  const description = typeof fm.description === "string" ? fm.description : "";
  const license = typeof fm.license === "string" ? fm.license : undefined;
  const compatibility = typeof fm.compatibility === "string" ? fm.compatibility : undefined;
  const allowedTools = typeof fm["allowed-tools"] === "string"
    ? String(fm["allowed-tools"]).trim()
    : undefined;

  // Pull the gini extension namespace.
  const metadata = fm.metadata && typeof fm.metadata === "object" && !Array.isArray(fm.metadata)
    ? fm.metadata as Record<string, unknown>
    : {};
  const giniExt = metadata.gini && typeof metadata.gini === "object" && !Array.isArray(metadata.gini)
    ? metadata.gini as Record<string, unknown>
    : null;

  // Detect frontmatter near-misses (top-level `gini:` block, misspelled keys
  // like `requirements` for `requires`) so the authoring model self-corrects
  // instead of silently dropping a credential/connector declaration.
  const warnings = detectGiniFrontmatterWarnings(fm, giniExt);

  // Source for version, platforms, prerequisites, requires.
  // Prefer metadata.gini.*; fall back to top-level for one release.
  function pickFromGiniOrTop(key: string): unknown {
    if (giniExt && key in giniExt) return giniExt[key];
    return fm[key];
  }

  const versionSource = pickFromGiniOrTop("version");
  const version = versionSource === undefined ? "1.0.0" : String(versionSource);

  const platformsSource = pickFromGiniOrTop("platforms");
  const platforms = Array.isArray(platformsSource) ? platformsSource.map(String) : undefined;

  let prerequisites: ParsedSkillFile["prerequisites"];
  const preSource = pickFromGiniOrTop("prerequisites");
  if (preSource && typeof preSource === "object" && !Array.isArray(preSource)) {
    const pre = preSource as Record<string, unknown>;
    prerequisites = {
      commands: Array.isArray(pre.commands) ? pre.commands.map(String) : undefined,
      env: Array.isArray(pre.env) ? pre.env.map(String) : undefined
    };
  }

  let requiredConnectors: ParsedSkillFile["requiredConnectors"];
  let requiredCredentials: ParsedSkillFile["requiredCredentials"];
  let requiresApprovalScripts: ParsedSkillFile["requiresApprovalScripts"];
  const requiresSource = pickFromGiniOrTop("requires");
  if (requiresSource && typeof requiresSource === "object" && !Array.isArray(requiresSource)) {
    const reqs = requiresSource as Record<string, unknown>;
    if (Array.isArray(reqs.credentials)) {
      const names = reqs.credentials
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0);
      if (names.length > 0) requiredCredentials = names;
    }
    if (Array.isArray(reqs.approval)) {
      const scripts = reqs.approval
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0);
      if (scripts.length > 0) requiresApprovalScripts = scripts;
    }
    const connectorList = Array.isArray(reqs.connectors)
      ? reqs.connectors
      : Array.isArray((reqs as { identities?: unknown }).identities)
        ? (reqs as { identities: unknown[] }).identities
        : null;
    if (Array.isArray(connectorList)) {
      // Warn once when the legacy `requires.identities` shape is used so
      // skill authors know to migrate. The check on which key was present
      // is best-effort — both shapes collapse to the same parsed result.
      if (Array.isArray((reqs as { identities?: unknown }).identities) && !Array.isArray(reqs.connectors)) {
        const where = sourcePath ? ` (${sourcePath})` : "";
        console.warn(`[skill-loader] DEPRECATION${where}: requires.identities is renamed to requires.connectors; legacy field still accepted for one release.`);
      }
      const collected: Array<{ provider: string; scopes?: string[] }> = [];
      for (const entry of connectorList) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const item = entry as Record<string, unknown>;
        // Spec form: `provider`. Legacy: `kind`. Accept both.
        const provider = typeof item.provider === "string"
          ? item.provider
          : typeof item.kind === "string" ? item.kind : "";
        if (!provider) continue;
        const scopes = Array.isArray(item.scopes) ? item.scopes.map(String) : undefined;
        collected.push(scopes ? { provider, scopes } : { provider });
      }
      requiredConnectors = collected;
    }
  }

  // Backward-compat: a skill that still declares only the legacy
  // `requires.connectors` form gets its `requiredCredentials` derived from the
  // provider→canonical-name mapping so runtime resolution (purely name-based)
  // keeps working for one release. Only template providers map; `generic`/
  // unknown providers carry no canonical name and are dropped from the list.
  if (!requiredCredentials && requiredConnectors && requiredConnectors.length > 0) {
    const derived = requiredConnectors
      .map((req) => canonicalCredentialName(req.provider))
      .filter((name): name is string => Boolean(name));
    if (derived.length > 0) requiredCredentials = derived;
  }

  // One-shot deprecation warnings for the legacy top-level Gini fields.
  if (!giniExt) {
    const legacyFields = ["version", "author", "platforms", "prerequisites", "requires"].filter((k) => k in fm);
    if (legacyFields.length > 0) {
      const where = sourcePath ? ` (${sourcePath})` : "";
      console.warn(`[skill-loader] DEPRECATION${where}: Gini-specific fields [${legacyFields.join(", ")}] should live under metadata.gini.*; legacy top-level form still accepted for one release.`);
    }
  }

  return {
    name,
    description,
    version,
    platforms,
    prerequisites,
    requiredConnectors,
    requiredCredentials,
    requiresApprovalScripts,
    allowedTools,
    license,
    compatibility,
    warnings: warnings.length > 0 ? warnings : undefined,
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
// are kept as separate rows so a user-instance SKILL.md cannot replace a
// vendored bundled skill. Preserves user-managed fields (`tests`,
// success/failure counts, previousVersions, lastUsedAt, and explicit
// disabled/archived status). On match: only bump the numeric version when
// the content changed. On miss: create filesystem skills as enabled.
// Validate a parsed skill against the Anthropic Agent Skills spec and
// against Gini extension rules. Returns a list of issues; empty array
// means the skill passes. Used both by the loader (to mark a row as
// `validationStatus: "unsupported"`) and by the `gini skill validate`
// CLI command.
export function validateParsedSkill(
  parsed: ParsedSkillFile,
  options: { manifestPath?: string; parentDirName?: string } = {}
): string[] {
  const issues: string[] = [];
  if (!parsed.name.trim()) {
    issues.push("Missing required `name` frontmatter field.");
  } else {
    if (parsed.name.length > 64) {
      issues.push(`name "${parsed.name}" exceeds 64-character spec limit.`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(parsed.name)) {
      issues.push(`name "${parsed.name}" must be lowercase, start with a letter, and contain only letters, digits, and hyphens.`);
    }
    if (options.parentDirName && options.parentDirName !== parsed.name) {
      issues.push(`name "${parsed.name}" must match the parent directory name "${options.parentDirName}".`);
    }
  }
  if (!parsed.description.trim()) {
    issues.push("Missing required `description` frontmatter field.");
  } else if (parsed.description.length > 1024) {
    issues.push("description exceeds 1024-character spec limit.");
  }
  if (parsed.compatibility && parsed.compatibility.length > 500) {
    issues.push("compatibility exceeds 500-character spec limit.");
  }
  // Legacy `requires.connectors` providers must still resolve to a registered
  // module. The name-based `requires.credentials` deliberately skips this gate:
  // a credential NAME is matched against a ConnectorRecord at runtime, not a
  // provider module, so a plain api-key (no module) is valid.
  for (const req of parsed.requiredConnectors ?? []) {
    if (!hasProvider(req.provider)) {
      issues.push(`Required provider "${req.provider}" is not in the connector registry; install a connector module or use "generic".`);
    }
  }
  return issues;
}

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

  // Validate at load time so the activation gate skips unsupported skills.
  const parentDirName = basename(dirname(origin.manifestPath));
  const issues = validateParsedSkill(parsed, { manifestPath: origin.manifestPath, parentDirName });
  const validationStatus: "ok" | "unsupported" = issues.length === 0 ? "ok" : "unsupported";
  // Advisory frontmatter warnings are surfaced in validationMessage too, but
  // never escalate validationStatus to "unsupported" — they don't block the
  // skill. console.warn so the near-miss is visible at boot/reload.
  const warnings = parsed.warnings ?? [];
  for (const warning of warnings) {
    console.warn(`[skill-loader] WARNING (${origin.manifestPath}): ${warning}`);
  }
  const messageParts = [...issues, ...warnings];
  const validationMessage = messageParts.length === 0 ? undefined : messageParts.join(" ");

  if (existing) {
    const changed =
      existing.body !== trimmedBody ||
      existing.description !== parsed.description ||
      existing.manifestPath !== origin.manifestPath ||
      existing.category !== origin.category ||
      existing.allowedTools !== parsed.allowedTools ||
      existing.license !== parsed.license ||
      existing.compatibility !== parsed.compatibility ||
      existing.validationStatus !== validationStatus ||
      existing.validationMessage !== validationMessage ||
      JSON.stringify(existing.platforms ?? null) !== JSON.stringify(parsed.platforms ?? null) ||
      JSON.stringify(existing.prerequisites ?? null) !== JSON.stringify(parsed.prerequisites ?? null) ||
      JSON.stringify(existing.requiredConnectors ?? null) !== JSON.stringify(parsed.requiredConnectors ?? null) ||
      JSON.stringify(existing.requiredCredentials ?? null) !== JSON.stringify(parsed.requiredCredentials ?? null) ||
      JSON.stringify(existing.requiresApprovalScripts ?? null) !== JSON.stringify(parsed.requiresApprovalScripts ?? null) ||
      (existing.manifestVersion ?? null) !== (parsed.version ?? null);
    if (!changed) return { record: existing, kind: "noop" };
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
      existing.requiredConnectors = parsed.requiredConnectors;
      existing.requiredCredentials = parsed.requiredCredentials;
      existing.requiresApprovalScripts = parsed.requiresApprovalScripts;
      existing.allowedTools = parsed.allowedTools;
      existing.license = parsed.license;
      existing.compatibility = parsed.compatibility;
      existing.manifestVersion = parsed.version;
      existing.validationStatus = validationStatus;
      existing.validationMessage = validationMessage;
      existing.version += 1;
    }
    existing.updatedAt = at;
    return { record: existing, kind: "updated" };
  }

  const initialStatus: SkillStatus = "enabled";
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
    requiredConnectors: parsed.requiredConnectors,
    requiredCredentials: parsed.requiredCredentials,
    requiresApprovalScripts: parsed.requiresApprovalScripts,
    allowedTools: parsed.allowedTools,
    license: parsed.license,
    compatibility: parsed.compatibility,
    manifestVersion: parsed.version,
    validationStatus,
    validationMessage,
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
        parsed = parseSkillFile(raw, entry.manifestPath);
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
        // Filesystem skill loading is instance-wide startup work — no
        // agent owns the load pass.
        appendEvent(
          state,
          {
            kind: "skill",
            action: "skill.skipped",
            target: parsed.name,
            risk: "low",
            summary: `Skipped ${parsed.name}: platform mismatch`,
            data: { platforms: parsed.platforms, host: hostPlatformTag() }
          },
          { system: true }
        );
        continue;
      }
      const upsert = upsertSkillFromFile(state, parsed, entry);
      if (upsert.kind === "added") {
        result.added.push(upsert.record);
        addAudit(
          state,
          {
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
          },
          { system: true }
        );
      } else if (upsert.kind === "updated") {
        result.updated.push(upsert.record);
        addAudit(
          state,
          {
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
          },
          { system: true }
        );
      }
    }
    return result;
  });
}
