import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { projectRoot } from "./paths";
import { assertInsideWorkspace } from "./state";

// GitHub-style heading slug. Matches the anchors the hosted docs site (and the
// in-repo `#fragment` references) use, so a hosted URL's `#re-authentication`
// fragment resolves to the same section here.
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

// The repo's top-level docs/ dir IS the source of the hosted site's content and
// is always present at projectRoot() (the gateway runs from the checkout).
export function docsRoot(): string {
  return join(projectRoot(), "docs");
}

// Resolve a doc path (with or without a trailing `.md`) under docsRoot(),
// confined by assertInsideWorkspace so a traversal path throws. Only `.md` is
// served.
export function resolveDocPath(path: string): string {
  const normalized = path.replace(/\.md$/, "");
  return assertInsideWorkspace(docsRoot(), `${normalized}.md`);
}

export interface DocSection {
  path: string;
  title: string;
  markdown: string;
  anchor?: string;
}

const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

// Humanize the last path segment as a title fallback when a doc has no H1.
function humanizeSegment(path: string): string {
  const segment = basename(path).replace(/\.md$/, "");
  return segment
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Read a doc's markdown, optionally narrowed to a single `#anchor` section.
// Heading scanning ignores lines inside fenced code blocks so a `# comment`
// inside a ``` block never matches as a heading.
export function readDocSection(path: string, section?: string): DocSection {
  const absolute = resolveDocPath(path);
  const content = readFileSync(absolute, "utf8");
  const lines = content.split("\n");

  // Index every heading once (line index, level, slug), skipping fenced blocks.
  const headings: Array<{ index: number; level: number; slug: string; text: string }> = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = HEADING.exec(line);
    if (match) {
      headings.push({ index, level: match[1].length, slug: slugifyHeading(match[2]), text: match[2] });
    }
  }

  const h1 = headings.find((heading) => heading.level === 1);
  const title = h1 ? h1.text : humanizeSegment(path);

  if (section) {
    const requested = slugifyHeading(section);
    const startPos = headings.findIndex((heading) => heading.slug === requested);
    if (startPos >= 0) {
      const start = headings[startPos];
      // End at the next heading whose level is the same or higher (≤ level), so
      // deeper sub-sections stay inside the slice.
      const next = headings.slice(startPos + 1).find((heading) => heading.level <= start.level);
      const end = next ? next.index : lines.length;
      const markdown = lines.slice(start.index, end).join("\n").trim();
      return { path, title, markdown, anchor: start.slug };
    }
    // Anchor not found: fall through to the full-doc body rather than throwing.
  }

  // No usable section: return the full doc with its leading H1 line removed so
  // the panel header's title isn't duplicated in the body.
  const bodyLines = h1 ? [...lines.slice(0, h1.index), ...lines.slice(h1.index + 1)] : lines;
  const markdown = bodyLines.join("\n").trim();
  return { path, title, markdown };
}
