#!/usr/bin/env bun
// Deterministic integrity engine for a knowledge-base wiki.
//
// Reads every markdown page under the wiki root, parses frontmatter and
// [[wikilinks]], builds the link graph, and reports the problems an LLM
// cannot reliably catch by eyeballing files one at a time: broken links,
// orphan pages, index drift, missing/invalid frontmatter, backlink
// asymmetry, oversized pages, stale pages, and tag-taxonomy violations.
//
// Invoked by the agent via `skill_run({skill:'knowledge-base',
// script:'lint', args:{...}})`. Args (JSON on stdin):
//   root?:      wiki dir relative to the workspace (auto-detected when omitted)
//   maxLines?:  oversized-page threshold (default 200)
//   staleDays?: stale-page threshold in days (default 180)
// Output: a single JSON object on stdout (see Report below). Never throws —
// failures surface as { ok:false, error }.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename, sep } from "node:path";

interface Args {
  root?: string;
  maxLines?: number;
  staleDays?: number;
}

export interface LintOptions {
  maxLines?: number;
  staleDays?: number;
  today?: Date;
}

const REQUIRED_FRONTMATTER = ["title", "created", "updated", "type", "tags", "sources"];
const ALLOWED_TYPES = ["entity", "concept", "comparison", "query", "summary", "index"];
const MIN_OUTBOUND_LINKS = 2;
const SPECIAL_FILES = new Set(["index.md", "log.md", "schema.md", "readme.md"]);

// Match the runtime's slugifyHeading (src/docs.ts) so a [[Display Name]]
// link and an `acme-robotics.md` filename resolve to the same key.
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function readArgs(): Args {
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? (JSON.parse(raw) as Args) : {};
  } catch {
    return {};
  }
}

function fail(error: string): never {
  process.stdout.write(JSON.stringify({ ok: false, error }));
  process.exit(0);
}

// Recursively list .md files under dir, returning workspace-root-relative
// paths. Skips dot-dirs and node_modules defensively.
function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && entry.toLowerCase().endsWith(".md")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function splitFrontmatter(text: string): { fm: string | null; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { fm: null, body: normalized };
  const after = normalized.slice(3);
  const close = after.match(/^([\s\S]*?)\n---\s*\n?/);
  if (!close) return { fm: null, body: normalized };
  return { fm: (close[1] ?? "").replace(/^\n/, ""), body: after.slice(close[0].length) };
}

// Minimal frontmatter reader: scalars, inline `[a, b]` arrays, and block
// lists (`key:` then `- item` lines). Sufficient for wiki page frontmatter.
function parseFrontmatter(fm: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) continue; // handled by block-list lookahead below
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (rest) {
      if (rest.startsWith("[") && rest.endsWith("]")) {
        const inner = rest.slice(1, -1).trim();
        out[key] = inner ? inner.split(",").map((s) => unquote(s.trim())) : [];
      } else {
        out[key] = unquote(rest);
      }
      continue;
    }
    // Block list: collect following `- ` lines.
    const items: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const next = lines[j]!;
      if (!next.trim()) continue;
      const m = next.match(/^\s+-\s+(.*)$/);
      if (!m) break;
      items.push(unquote(m[1]!.trim()));
    }
    if (items.length > 0) {
      out[key] = items;
      i = j - 1;
    } else {
      out[key] = "";
    }
  }
  return out;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// Extract [[wikilinks]] with line numbers. Handles [[Target]],
// [[Target|alias]], [[Target#section]]. Ignores links inside fenced code.
function extractLinks(body: string): Array<{ targetRaw: string; targetSlug: string; line: number }> {
  const links: Array<{ targetRaw: string; targetSlug: string; line: number }> = [];
  const lines = body.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      let target = m[1]!;
      const pipe = target.indexOf("|");
      if (pipe >= 0) target = target.slice(0, pipe);
      const hash = target.indexOf("#");
      if (hash >= 0) target = target.slice(0, hash);
      target = target.trim();
      if (!target) continue;
      links.push({ targetRaw: target, targetSlug: slugify(target), line: i + 1 });
    }
  }
  return links;
}

function dateOK(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function daysBetween(isoDate: string, today: Date): number {
  const then = new Date(`${isoDate.trim()}T00:00:00Z`);
  if (Number.isNaN(then.getTime())) return 0;
  return Math.floor((today.getTime() - then.getTime()) / 86_400_000);
}

// Parse the tag taxonomy out of SCHEMA.md: collect every backtick-wrapped
// token and `- item` bullet under any heading whose text contains "tag".
function parseTaxonomy(schemaText: string): Set<string> {
  const tags = new Set<string>();
  const lines = schemaText.split("\n");
  let inTagSection = false;
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inTagSection = /tag/i.test(heading[1]!);
      continue;
    }
    if (!inTagSection) continue;
    for (const code of line.matchAll(/`([^`]+)`/g)) tags.add(code[1]!.trim());
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      // first token of the bullet, stripped of backticks/punctuation
      const token = bullet[1]!.replace(/`/g, "").split(/[\s—:|]/)[0]!.trim();
      if (token) tags.add(token);
    }
  }
  return tags;
}

// Pure integrity pass over an absolute wiki root. Takes injectable options
// (notably `today`) so the stale check is deterministic under test. Returns
// the JSON report object the script prints. Exported for unit testing; the
// CLI wrapper (main) resolves the root from env/args and calls this.
export function lintWiki(wikiRoot: string, rootLabel: string, opts: LintOptions = {}) {
  const maxLines = typeof opts.maxLines === "number" ? opts.maxLines : 200;
  const staleDays = typeof opts.staleDays === "number" ? opts.staleDays : 180;
  const today = opts.today ?? new Date();
  const root = rootLabel;

  const files = listMarkdown(wikiRoot);

  interface Page {
    slug: string;
    rel: string; // path relative to wiki root
    filename: string;
    fm: Record<string, unknown> | null;
    bodyLines: number;
    links: Array<{ targetRaw: string; targetSlug: string; line: number }>;
  }

  const pages: Page[] = [];
  let indexLinks: Array<{ targetRaw: string; targetSlug: string; line: number }> = [];
  let hasIndex = false;
  let hasSchema = false;
  let taxonomy = new Set<string>();

  for (const file of files) {
    const rel = relative(wikiRoot, file);
    const lowerName = basename(file).toLowerCase();
    const isRaw = rel.split(sep)[0] === "raw";
    const text = readFileSync(file, "utf8");

    if (lowerName === "schema.md") {
      hasSchema = true;
      taxonomy = parseTaxonomy(text);
      continue;
    }
    if (lowerName === "index.md") {
      hasIndex = true;
      const { body } = splitFrontmatter(text);
      indexLinks = extractLinks(body);
      continue;
    }
    if (SPECIAL_FILES.has(lowerName) && !rel.includes(sep)) continue; // log.md, readme.md at root
    if (isRaw) continue; // immutable sources — never linted

    const { fm, body } = splitFrontmatter(text);
    pages.push({
      slug: slugify(basename(file, ".md")),
      rel,
      filename: basename(file),
      fm: fm === null ? null : parseFrontmatter(fm),
      bodyLines: body.split("\n").length,
      links: extractLinks(body)
    });
  }

  const slugSet = new Set(pages.map((p) => p.slug));

  // Inbound link graph (page → set of pages linking to it).
  const inbound = new Map<string, Set<string>>();
  for (const p of pages) inbound.set(p.slug, new Set());
  for (const p of pages) {
    for (const link of p.links) {
      if (link.targetSlug === p.slug) continue; // self-link
      if (slugSet.has(link.targetSlug)) inbound.get(link.targetSlug)!.add(p.slug);
    }
  }

  // Broken links: a link target that resolves to no page (and isn't a
  // special page like the index itself).
  const brokenLinks: Array<{ from: string; target: string; line: number }> = [];
  for (const p of pages) {
    for (const link of p.links) {
      if (link.targetSlug === p.slug) continue;
      if (slugSet.has(link.targetSlug)) continue;
      if (SPECIAL_FILES.has(`${link.targetSlug}.md`)) continue;
      brokenLinks.push({ from: p.rel, target: link.targetRaw, line: link.line });
    }
  }

  // Orphans: pages no other page links to.
  const orphans = pages.filter((p) => inbound.get(p.slug)!.size === 0).map((p) => p.rel);

  // Backlink asymmetry: A links B, B does not link A.
  const asymmetry: Array<{ from: string; to: string }> = [];
  const linkSetBySlug = new Map<string, Set<string>>();
  for (const p of pages) linkSetBySlug.set(p.slug, new Set(p.links.map((l) => l.targetSlug)));
  for (const p of pages) {
    for (const targetSlug of linkSetBySlug.get(p.slug)!) {
      if (!slugSet.has(targetSlug) || targetSlug === p.slug) continue;
      if (!linkSetBySlug.get(targetSlug)!.has(p.slug)) {
        asymmetry.push({ from: p.slug, to: targetSlug });
      }
    }
  }

  // Index drift.
  const indexSlugs = new Set(indexLinks.map((l) => l.targetSlug));
  const missingFromIndex = hasIndex ? pages.filter((p) => !indexSlugs.has(p.slug)).map((p) => p.rel) : [];
  const indexEntriesWithoutPage = hasIndex
    ? indexLinks.filter((l) => !slugSet.has(l.targetSlug) && !SPECIAL_FILES.has(`${l.targetSlug}.md`)).map((l) => l.targetRaw)
    : [];

  // Frontmatter validation + outbound-link minimum.
  const frontmatter: Array<{ page: string; issues: string[] }> = [];
  const unknownTagsUsed: Array<{ page: string; tag: string }> = [];
  for (const p of pages) {
    const issues: string[] = [];
    if (p.fm === null) {
      issues.push("no frontmatter block");
    } else {
      for (const key of REQUIRED_FRONTMATTER) {
        if (!(key in p.fm) || p.fm[key] === "" || (Array.isArray(p.fm[key]) && (p.fm[key] as unknown[]).length === 0)) {
          issues.push(`missing or empty '${key}'`);
        }
      }
      if ("created" in p.fm && !dateOK(p.fm.created)) issues.push("'created' is not YYYY-MM-DD");
      if ("updated" in p.fm && !dateOK(p.fm.updated)) issues.push("'updated' is not YYYY-MM-DD");
      if (typeof p.fm.type === "string" && p.fm.type && !ALLOWED_TYPES.includes(p.fm.type)) {
        issues.push(`type '${p.fm.type}' not in ${ALLOWED_TYPES.join("|")}`);
      }
      const tags = Array.isArray(p.fm.tags) ? (p.fm.tags as unknown[]).map(String) : [];
      if (hasSchema && taxonomy.size > 0) {
        for (const tag of tags) {
          if (!taxonomy.has(tag)) unknownTagsUsed.push({ page: p.rel, tag });
        }
      }
    }
    const distinctOutbound = new Set(p.links.filter((l) => l.targetSlug !== p.slug).map((l) => l.targetSlug));
    if (distinctOutbound.size < MIN_OUTBOUND_LINKS) {
      issues.push(`fewer than ${MIN_OUTBOUND_LINKS} outbound links (${distinctOutbound.size})`);
    }
    if (issues.length > 0) frontmatter.push({ page: p.rel, issues });
  }

  // Oversized + stale + non-slug filenames.
  const oversized = pages.filter((p) => p.bodyLines > maxLines).map((p) => ({ page: p.rel, lines: p.bodyLines }));
  const stale: Array<{ page: string; updated: string; ageDays: number }> = [];
  for (const p of pages) {
    const updated = p.fm && typeof p.fm.updated === "string" ? p.fm.updated : null;
    if (updated && dateOK(updated)) {
      const age = daysBetween(updated, today);
      if (age > staleDays) stale.push({ page: p.rel, updated, ageDays: age });
    }
  }
  const nonSlugFilenames = pages
    .filter((p) => basename(p.filename, ".md") !== slugify(basename(p.filename, ".md")))
    .map((p) => p.rel);

  const counts = {
    pages: pages.length,
    brokenLinks: brokenLinks.length,
    orphans: orphans.length,
    missingFromIndex: missingFromIndex.length,
    indexEntriesWithoutPage: indexEntriesWithoutPage.length,
    frontmatterIssues: frontmatter.length,
    backlinkAsymmetry: asymmetry.length,
    oversized: oversized.length,
    stale: stale.length,
    unknownTagsUsed: unknownTagsUsed.length,
    nonSlugFilenames: nonSlugFilenames.length
  };
  const totalIssues =
    counts.brokenLinks +
    counts.orphans +
    counts.missingFromIndex +
    counts.indexEntriesWithoutPage +
    counts.frontmatterIssues +
    counts.oversized +
    counts.unknownTagsUsed +
    counts.nonSlugFilenames;

  const structure = {
    hasIndex,
    hasSchema,
    taxonomyTags: [...taxonomy].sort()
  };

  return {
    ok: true as const,
    root,
    clean: totalIssues === 0,
    totalIssues,
    counts,
    structure,
    brokenLinks,
    orphans,
    missingFromIndex,
    indexEntriesWithoutPage,
    frontmatter,
    backlinkAsymmetry: asymmetry,
    oversized,
    stale,
    unknownTagsUsed,
    nonSlugFilenames
  };
}

function main() {
  const args = readArgs();
  const workspace = process.env.GINI_WORKSPACE;
  if (!workspace) fail("GINI_WORKSPACE is not set; run this via skill_run.");

  // Resolve the wiki root: explicit arg, else first existing of wiki/ or
  // knowledge-base/, else fail with guidance.
  let root = args.root;
  if (!root) {
    for (const candidate of ["wiki", "knowledge-base"]) {
      if (existsSync(join(workspace!, candidate))) {
        root = candidate;
        break;
      }
    }
  }
  if (!root) fail("No wiki root found. Pass args.root (e.g. 'wiki') or create the wiki first.");
  const wikiRoot = join(workspace!, root!);
  if (!existsSync(wikiRoot)) fail(`Wiki root does not exist: ${root}`);

  const report = lintWiki(wikiRoot, root!, {
    maxLines: typeof args.maxLines === "number" ? args.maxLines : undefined,
    staleDays: typeof args.staleDays === "number" ? args.staleDays : undefined
  });
  process.stdout.write(JSON.stringify(report));
}

if (import.meta.main) main();
