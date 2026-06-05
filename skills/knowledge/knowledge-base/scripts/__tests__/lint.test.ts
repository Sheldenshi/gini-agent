// Unit tests for the knowledge-base wiki integrity engine (../lint.ts).
// Imports the pure lintWiki() export (the script guards its CLI main with
// import.meta.main, so importing it here does not execute the CLI path).
// Each test builds a throwaway wiki under a unique temp dir.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintWiki } from "../lint";

function tempWiki(): string {
  return mkdtempSync(join(tmpdir(), "gini-wiki-lint-"));
}

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

interface PageOpts {
  title?: string;
  created?: string;
  updated?: string;
  type?: string;
  tags?: string[];
  sources?: string[];
  body?: string;
}

// Build a fully-valid page; callers override fields to inject defects.
function page(opts: PageOpts & { links: string[] }): string {
  const fm = [
    "---",
    `title: ${opts.title ?? "A Page"}`,
    `created: ${opts.created ?? "2026-01-01"}`,
    `updated: ${opts.updated ?? "2026-01-01"}`,
    `type: ${opts.type ?? "entity"}`,
    `tags: [${(opts.tags ?? ["models"]).join(", ")}]`,
    `sources: [${(opts.sources ?? ["raw/articles/x.md"]).join(", ")}]`,
    "---",
    ""
  ].join("\n");
  const links = opts.links.map((l) => `- [[${l}]]`).join("\n");
  return `${fm}# ${opts.title ?? "A Page"}\n\n${opts.body ?? "Body."}\n\n## Links\n${links}\n`;
}

const SCHEMA = `# Schema\n\n## Tag taxonomy\n\n- models\n- people\n- techniques\n`;

describe("lintWiki: clean wiki", () => {
  test("a well-formed bidirectional wiki reports clean", () => {
    const root = tempWiki();
    try {
      write(root, "SCHEMA.md", SCHEMA);
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      write(root, "pages/alpha.md", page({ title: "Alpha", tags: ["models"], links: ["beta", "index"] }));
      write(root, "pages/beta.md", page({ title: "Beta", tags: ["people"], links: ["alpha", "index"] }));
      const r = lintWiki(root, "wiki");
      expect(r.ok).toBe(true);
      expect(r.clean).toBe(true);
      expect(r.totalIssues).toBe(0);
      expect(r.counts.pages).toBe(2);
      expect(r.structure.hasIndex).toBe(true);
      expect(r.structure.hasSchema).toBe(true);
      expect(r.structure.taxonomyTags).toEqual(["models", "people", "techniques"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("lintWiki: link integrity", () => {
  test("resolves [[Display Name]] to its slug file (no false broken link)", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[acme-robotics]]\n- [[jane-doe]]\n");
      write(root, "pages/acme-robotics.md", page({ title: "Acme", links: ["Jane Doe", "index"] }));
      write(root, "pages/jane-doe.md", page({ title: "Jane", links: ["Acme Robotics", "index"] }));
      const r = lintWiki(root, "wiki");
      expect(r.counts.brokenLinks).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags a link to a missing page as broken", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      write(root, "pages/alpha.md", page({ title: "Alpha", links: ["beta", "ghost-page"] }));
      write(root, "pages/beta.md", page({ title: "Beta", links: ["alpha", "index"] }));
      const r = lintWiki(root, "wiki");
      expect(r.counts.brokenLinks).toBe(1);
      expect(r.brokenLinks[0]!.target).toBe("ghost-page");
      expect(r.brokenLinks[0]!.from).toBe(join("pages", "alpha.md"));
      // line is file-relative (frontmatter offset included), not body-relative.
      // alpha.md: 8 frontmatter lines, then "# Alpha", blank, "Body.", blank,
      // "## Links", "- [[beta]]", "- [[ghost-page]]" → ghost on file line 15.
      expect(r.brokenLinks[0]!.line).toBe(15);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores [[links]] inside fenced code blocks", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      write(
        root,
        "pages/alpha.md",
        [
          "---",
          "title: Alpha",
          "created: 2026-01-01",
          "updated: 2026-01-01",
          "type: entity",
          "tags: [models]",
          "sources: [raw/x.md]",
          "---",
          "",
          "# Alpha",
          "",
          "Links: [[beta]] and [[index]].",
          "",
          "```",
          "this [[ghost-in-code]] must not count as a link",
          "```",
          ""
        ].join("\n")
      );
      write(root, "pages/beta.md", page({ title: "Beta", links: ["alpha", "index"] }));
      const r = lintWiki(root, "wiki");
      expect(r.counts.brokenLinks).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags an orphan page nothing links to", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n- [[lonely]]\n");
      write(root, "pages/alpha.md", page({ title: "Alpha", links: ["beta", "index"] }));
      write(root, "pages/beta.md", page({ title: "Beta", links: ["alpha", "index"] }));
      // lonely is linked only from the index, not from any page → orphan in the graph
      write(root, "pages/lonely.md", page({ title: "Lonely", links: ["alpha", "beta"] }));
      const r = lintWiki(root, "wiki");
      expect(r.orphans).toContain(join("pages", "lonely.md"));
      expect(r.orphans).not.toContain(join("pages", "alpha.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports backlink asymmetry (A links B, B does not link A)", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      write(root, "pages/alpha.md", page({ title: "Alpha", links: ["beta", "index"] }));
      write(root, "pages/beta.md", page({ title: "Beta", links: ["index", "alpha"] }));
      // symmetric → no asymmetry
      let r = lintWiki(root, "wiki");
      expect(r.counts.backlinkAsymmetry).toBe(0);
      // break symmetry: beta no longer links alpha
      write(root, "pages/beta.md", page({ title: "Beta", links: ["index", "alpha-other"] }));
      write(root, "pages/alpha-other.md", page({ title: "Other", links: ["beta", "index"] }));
      r = lintWiki(root, "wiki");
      expect(r.backlinkAsymmetry.some((a) => a.from === "alpha" && a.to === "beta")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("lintWiki: index drift", () => {
  test("reports pages missing from the index and index entries with no page", () => {
    const root = tempWiki();
    try {
      // index lists alpha + a phantom; beta exists but is not indexed
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[phantom]]\n");
      write(root, "pages/alpha.md", page({ title: "Alpha", links: ["beta", "index"] }));
      write(root, "pages/beta.md", page({ title: "Beta", links: ["alpha", "index"] }));
      const r = lintWiki(root, "wiki");
      expect(r.missingFromIndex).toContain(join("pages", "beta.md"));
      expect(r.indexEntriesWithoutPage).toContain("phantom");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("lintWiki: frontmatter + taxonomy", () => {
  test("flags missing frontmatter, bad date, bad type, and too-few links", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[good]]\n- [[bad]]\n");
      write(root, "pages/good.md", page({ title: "Good", links: ["bad", "index"] }));
      // bad: invalid date, invalid type, only one outbound link, missing sources
      write(
        root,
        "pages/bad.md",
        [
          "---",
          "title: Bad",
          "created: not-a-date",
          "updated: 2026-01-01",
          "type: nonsense",
          "tags: [models]",
          "---",
          "",
          "# Bad",
          "",
          "Only one link: [[good]].",
          ""
        ].join("\n")
      );
      const r = lintWiki(root, "wiki");
      const badIssues = r.frontmatter.find((f) => f.page === join("pages", "bad.md"));
      expect(badIssues).toBeTruthy();
      const text = badIssues!.issues.join(" | ");
      expect(text).toContain("'created' is not YYYY-MM-DD");
      expect(text).toContain("not in");
      expect(text).toMatch(/missing or empty 'sources'/);
      expect(text).toMatch(/fewer than 2 resolved outbound links/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses block-list frontmatter (tags/sources as - items, not inline arrays)", () => {
    const root = tempWiki();
    try {
      write(root, "SCHEMA.md", SCHEMA);
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      // alpha uses YAML block sequences for tags + sources instead of [a, b]
      write(
        root,
        "pages/alpha.md",
        [
          "---",
          "title: Alpha",
          "created: 2026-01-01",
          "updated: 2026-01-01",
          "type: entity",
          "tags:",
          "  - models",
          "  - people",
          "sources:",
          "  - raw/articles/x.md",
          "---",
          "",
          "# Alpha",
          "",
          "Links: [[beta]] and [[index]].",
          ""
        ].join("\n")
      );
      write(root, "pages/beta.md", page({ title: "Beta", links: ["alpha", "index"] }));
      const r = lintWiki(root, "wiki");
      // No frontmatter complaints for alpha: tags + sources parsed from the block list.
      expect(r.frontmatter.find((f) => f.page === join("pages", "alpha.md"))).toBeUndefined();
      // And the block-list tags are taxonomy-checked (no unknown-tag false positives).
      expect(r.unknownTagsUsed.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags a tag outside the SCHEMA taxonomy", () => {
    const root = tempWiki();
    try {
      write(root, "SCHEMA.md", SCHEMA);
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      write(root, "pages/alpha.md", page({ title: "Alpha", tags: ["models", "made-up-tag"], links: ["beta", "index"] }));
      write(root, "pages/beta.md", page({ title: "Beta", tags: ["people"], links: ["alpha", "index"] }));
      const r = lintWiki(root, "wiki");
      expect(r.unknownTagsUsed.some((u) => u.tag === "made-up-tag")).toBe(true);
      expect(r.unknownTagsUsed.some((u) => u.tag === "models")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("lintWiki: size, staleness, naming, raw/", () => {
  test("flags oversized pages against maxLines", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[big]]\n- [[beta]]\n");
      const longBody = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
      write(root, "pages/big.md", page({ title: "Big", links: ["beta", "index"], body: longBody }));
      write(root, "pages/beta.md", page({ title: "Beta", links: ["big", "index"] }));
      const r = lintWiki(root, "wiki", { maxLines: 20 });
      expect(r.oversized.some((o) => o.page === join("pages", "big.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags stale pages relative to an injected today", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[old]]\n- [[fresh]]\n");
      write(root, "pages/old.md", page({ title: "Old", updated: "2025-01-01", links: ["fresh", "index"] }));
      write(root, "pages/fresh.md", page({ title: "Fresh", updated: "2026-05-01", links: ["old", "index"] }));
      const r = lintWiki(root, "wiki", { staleDays: 90, today: new Date("2026-06-01T00:00:00Z") });
      expect(r.stale.some((s) => s.page === join("pages", "old.md"))).toBe(true);
      expect(r.stale.some((s) => s.page === join("pages", "fresh.md"))).toBe(false);
      // stale is advisory: it must NOT gate clean / count toward totalIssues.
      expect(r.totalIssues).toBe(0);
      expect(r.clean).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags non-slug filenames and never lints raw/ sources", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      write(root, "pages/alpha.md", page({ title: "Alpha", links: ["beta", "index"] }));
      write(root, "pages/beta.md", page({ title: "Beta", links: ["alpha", "index"] }));
      write(root, "pages/Has Spaces.md", page({ title: "Spaces", links: ["alpha", "beta"] }));
      // raw source with no frontmatter and a broken link — must be ignored
      write(root, "raw/articles/source.md", "no frontmatter and a [[ghost]] link\n");
      const r = lintWiki(root, "wiki");
      expect(r.nonSlugFilenames).toContain(join("pages", "Has Spaces.md"));
      expect(r.counts.brokenLinks).toBe(0);
      // raw source is not counted as a page
      expect(r.counts.pages).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("lintWiki: review hardening", () => {
  test("detects duplicate slugs and counts them as blocking", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[alpha]]\n");
      write(root, "pages/alpha.md", page({ title: "Alpha", links: ["beta", "index"] }));
      write(root, "pages/beta.md", page({ title: "Beta", links: ["alpha", "index"] }));
      // archive/alpha.md collides with pages/alpha.md on slug "alpha"
      write(root, "archive/alpha.md", page({ title: "Alpha Archived", links: ["beta", "index"] }));
      const r = lintWiki(root, "wiki");
      const dup = r.duplicateSlugs.find((d) => d.slug === "alpha");
      expect(dup).toBeTruthy();
      expect(dup!.files).toEqual([join("archive", "alpha.md"), join("pages", "alpha.md")]);
      expect(r.counts.duplicateSlugs).toBe(1);
      expect(r.clean).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a nested index.md/schema.md does not hijack the root catalog/taxonomy", () => {
    const root = tempWiki();
    try {
      write(root, "SCHEMA.md", SCHEMA);
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      write(root, "pages/alpha.md", page({ title: "Alpha", tags: ["models"], links: ["beta", "index"] }));
      write(root, "pages/beta.md", page({ title: "Beta", tags: ["people"], links: ["alpha", "index"] }));
      // A file literally named index.md but NESTED must NOT be read as the root
      // index (its [[alpha]]-only list would otherwise make beta look unindexed).
      write(root, "pages/sub/index.md", page({ title: "Sub Index", tags: ["models"], links: ["alpha"] }));
      // A nested schema.md must NOT replace the root tag taxonomy.
      write(root, "pages/sub/schema.md", page({ title: "Sub Schema", tags: ["people"], links: ["alpha", "beta"] }));
      const r = lintWiki(root, "wiki");
      // root taxonomy intact (nested schema.md did not overwrite it)
      expect(r.structure.taxonomyTags).toEqual(["models", "people", "techniques"]);
      // root index drives drift: beta stays indexed (nested index.md did not win)
      expect(r.missingFromIndex).not.toContain(join("pages", "beta.md"));
      // both nested files are linted as pages, not silently dropped → 4 pages
      expect(r.counts.pages).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores [[links]] in inline code spans and ~~~ fences", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      write(
        root,
        "pages/alpha.md",
        [
          "---",
          "title: Alpha",
          "created: 2026-01-01",
          "updated: 2026-01-01",
          "type: entity",
          "tags: [models]",
          "sources: [raw/x.md]",
          "---",
          "",
          "# Alpha",
          "",
          "Real links: [[beta]] and [[index]].",
          "Inline code `[[ghost-a]]` should not count.",
          "",
          "~~~",
          "[[ghost-b]] inside a tilde fence",
          "~~~",
          ""
        ].join("\n")
      );
      write(root, "pages/beta.md", page({ title: "Beta", links: ["alpha", "index"] }));
      const r = lintWiki(root, "wiki");
      expect(r.counts.brokenLinks).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("min-outbound counts only resolved targets (a broken link does not pad it)", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      // alpha: one resolved page link + one broken link → only 1 resolved outbound
      write(root, "pages/alpha.md", page({ title: "Alpha", links: ["beta", "ghost"] }));
      write(root, "pages/beta.md", page({ title: "Beta", links: ["alpha", "index"] }));
      const r = lintWiki(root, "wiki");
      const alpha = r.frontmatter.find((f) => f.page === join("pages", "alpha.md"));
      expect(alpha).toBeTruthy();
      expect(alpha!.issues.join(" | ")).toMatch(/fewer than 2 resolved outbound links/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("indexEntriesWithoutPage gates clean", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n- [[phantom]]\n");
      write(root, "pages/alpha.md", page({ title: "Alpha", links: ["beta", "index"] }));
      write(root, "pages/beta.md", page({ title: "Beta", links: ["alpha", "index"] }));
      const r = lintWiki(root, "wiki");
      expect(r.indexEntriesWithoutPage).toContain("phantom");
      expect(r.clean).toBe(false);
      expect(r.totalIssues).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not flag tags when no SCHEMA taxonomy is present", () => {
    const root = tempWiki();
    try {
      // no SCHEMA.md → tags are unchecked (can't validate against an absent taxonomy)
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      write(root, "pages/alpha.md", page({ title: "Alpha", tags: ["anything-goes"], links: ["beta", "index"] }));
      write(root, "pages/beta.md", page({ title: "Beta", tags: ["whatever"], links: ["alpha", "index"] }));
      const r = lintWiki(root, "wiki");
      expect(r.structure.hasSchema).toBe(false);
      expect(r.unknownTagsUsed.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses an inline array that has a trailing YAML comment", () => {
    const root = tempWiki();
    try {
      write(root, "SCHEMA.md", SCHEMA);
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      write(
        root,
        "pages/alpha.md",
        [
          "---",
          "title: Alpha",
          "created: 2026-01-01",
          "updated: 2026-01-01",
          "type: entity",
          "tags: [models, people]   # primary categories",
          "sources: [raw/x.md]",
          "---",
          "",
          "# Alpha",
          "",
          "Links: [[beta]] and [[index]].",
          ""
        ].join("\n")
      );
      write(root, "pages/beta.md", page({ title: "Beta", links: ["alpha", "index"] }));
      const r = lintWiki(root, "wiki");
      // tags parsed as an array despite the trailing comment → no missing-tags issue,
      // and both are in the taxonomy → no unknown-tag false positive.
      expect(r.frontmatter.find((f) => f.page === join("pages", "alpha.md"))).toBeUndefined();
      expect(r.unknownTagsUsed.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("taxonomy parsing skips fenced code and spans sub-headings", () => {
    const root = tempWiki();
    try {
      const schema = [
        "# Schema",
        "",
        "## Tag taxonomy",
        "",
        "### Models",
        "- models",
        "",
        "### People",
        "- people",
        "",
        "```",
        "- not-a-real-tag-in-code",
        "```",
        "",
        "## Conventions",
        "- this-is-not-a-tag",
        ""
      ].join("\n");
      write(root, "SCHEMA.md", schema);
      write(root, "index.md", "# Index\n\n- [[alpha]]\n- [[beta]]\n");
      write(root, "pages/alpha.md", page({ title: "Alpha", tags: ["models"], links: ["beta", "index"] }));
      write(root, "pages/beta.md", page({ title: "Beta", tags: ["people"], links: ["alpha", "index"] }));
      const r = lintWiki(root, "wiki");
      // sub-headings inside the tag section are still collected
      expect(r.structure.taxonomyTags).toContain("models");
      expect(r.structure.taxonomyTags).toContain("people");
      // fenced-code bullet and the post-section "Conventions" bullet are excluded
      expect(r.structure.taxonomyTags).not.toContain("not-a-real-tag-in-code");
      expect(r.structure.taxonomyTags).not.toContain("this-is-not-a-tag");
      expect(r.unknownTagsUsed.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags an underscore filename and resolves [[Display Name]] to its hyphen slug", () => {
    const root = tempWiki();
    try {
      write(root, "index.md", "# Index\n\n- [[my-page]]\n- [[beta]]\n");
      // file uses underscores; a link uses the display form with a space
      write(root, "pages/my_page.md", page({ title: "My Page", links: ["beta", "index"] }));
      write(root, "pages/beta.md", page({ title: "Beta", links: ["My Page", "index"] }));
      const r = lintWiki(root, "wiki");
      // underscore filename is flagged for rename...
      expect(r.nonSlugFilenames).toContain(join("pages", "my_page.md"));
      // ...but [[My Page]] still resolves to my_page.md via the shared slug "my-page"
      expect(r.counts.brokenLinks).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
