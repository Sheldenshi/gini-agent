---
name: knowledge-base
description: "Build and maintain a company knowledge base as a wiki of interlinked markdown notes in the workspace — a private, compounding Wikipedia. Use when the user wants to start or organize a knowledge base / wiki, ingest sources (URLs, documents, pasted notes) into it, ask questions answered from it, or audit (lint) it. Defines the wiki layout (SCHEMA / index / log / raw / pages), the frontmatter contract, [[wikilink]] conventions, and a deterministic lint script that catches broken links, orphan pages, index drift, and frontmatter problems."
license: MIT
compatibility: "Requires the gini gateway. Uses the file tools and skill_run; no external credentials."
allowed-tools: "file_read file_list file_search file_write file_patch skill_run web_fetch web_search"
metadata:
  gini:
    version: 1.0.0
    author: Gini
    requires:
      credentials: []
---

# Knowledge Base (Wiki)

You maintain a **compounding knowledge base**: a wiki of interlinked markdown
notes that lives in the workspace. Unlike a chat that forgets, the wiki is
written once and kept correct — every new source is folded into existing
pages and cross-referenced, so the knowledge graph gets denser over time. The
files are plain markdown with `[[wikilinks]]`, so the user can also open them
in Obsidian or any editor.

## When to use

- "Set up a knowledge base / wiki", "start a company wiki", "organize my notes".
- "Add this to the wiki", "ingest this article/doc/page", "remember this for the team".
- A question that the wiki should answer ("what do we know about X?").
- "Audit / lint / health-check the wiki", "find broken links / orphans".

## When NOT to use

- One-off facts about the user or your own behavior → that's **memory** (retain), not the wiki.
- Throwaway scratch work, or content the user doesn't want kept.

## Layout

The wiki lives under `wiki/` in the workspace (use an existing root such as
`knowledge-base/` if one is already there). Structure:

```
wiki/
├── SCHEMA.md     # the domain, conventions, and tag taxonomy — defined once
├── index.md      # catalog of every page, grouped by type, each with a one-line summary
├── log.md        # append-only action log (newest entries at the bottom)
├── raw/          # captured sources, IMMUTABLE — you read these, never edit them
│   ├── articles/
│   ├── docs/
│   └── transcripts/
└── pages/        # the wiki pages (one entity/concept/comparison/query each)
```

Page filenames are **lowercase, hyphenated slugs, no spaces**: `acme-robotics.md`,
`atlas-robot.md`. A `[[Display Name]]` link resolves to the page whose slug
equals the slugified display name, so `[[Acme Robotics]]` and `[[acme-robotics]]`
both point at `pages/acme-robotics.md`.

## Frontmatter contract (mandatory on every page)

```yaml
---
title: Acme Robotics
created: 2026-06-05      # YYYY-MM-DD
updated: 2026-06-05      # YYYY-MM-DD — bump on every edit
type: entity             # entity | concept | comparison | query | summary
tags: [companies, robotics]   # every tag MUST appear in SCHEMA.md's taxonomy
sources: [raw/articles/acme-launch.md]   # the raw/ files this page draws on
# optional:
confidence: high         # high | medium | low
contested: true          # set when the page records a genuine contradiction
contradictions: [other-slug]
---
```

## Linking rules

- Use `[[slug]]` (or `[[slug|alias]]`) for every cross-reference. Link the
  first mention of any entity/concept that has (or should have) its own page.
- **Minimum 2 outbound links per page**, including a link back to a hub page
  or `[[index]]` where it helps navigation.
- **Bidirectional**: when page A links to B, make sure B links back to A when
  the relationship is real (e.g. a company links its CEO and the CEO links the
  company). The lint reports one-directional links so you can reciprocate them.
- **Provenance**: list every `raw/` file the page draws on in `sources:`.

## Page thresholds

- Create a page when an entity/concept appears in **2+ sources**, or is
  **central to one** source. Don't create pages for passing mentions.
- Split a page that grows past ~200 lines into focused sub-pages and link them.

## Operations

### 0. Orient (ALWAYS do this first)

Before creating or editing anything, read the lay of the land so you don't
duplicate pages or drift from the schema:

1. `file_read wiki/SCHEMA.md` — the domain + conventions + tag taxonomy.
2. `file_read wiki/index.md` — what pages already exist.
3. `file_read wiki/log.md` — recent activity (skim the tail).

If `wiki/` does not exist yet, go to **Init**.

### 1. Init (no wiki yet)

1. Create `wiki/` with `raw/` and `pages/` subfolders.
2. Write `SCHEMA.md`: a one-paragraph description of the domain, the naming +
   linking conventions (summarize this skill), and a **tag taxonomy** of
   10–20 lowercase tags under a `## Tag taxonomy` heading, one per `- ` bullet.
   If the domain is unclear, ask the user one question to scope it.
3. Write an empty-ish `index.md` (an `# Index` heading) and `log.md` (`# Log`).

### 2. Ingest a source (URL, document, pasted text)

1. **Orient** (step 0).
2. **Capture the source** verbatim into `raw/` (e.g. `raw/articles/<slug>.md`)
   with a tiny header (`source_url`, `ingested` date). For a URL, fetch it with
   `web_fetch` first. Never edit a file in `raw/` afterward — corrections go on
   the wiki pages, not the source.
3. **Extract** the entities/concepts worth pages (apply the threshold above).
4. For each, **check for an existing page**: `file_search` the name and scan
   `index.md`. Update the existing page rather than creating a duplicate.
5. **Create or update** pages with full frontmatter, `[[links]]`, and the new
   `raw/` path appended to `sources:`. Bump `updated:`.
6. **Reciprocate links** on the pages you touched (bidirectional rule).
7. **Update `index.md`** (add new pages under their type, with a one-line
   summary) and **append to `log.md`** (`- 2026-06-05 — ingested <source>; added/updated <pages>`).
8. **Lint and fix** (step 4).

### 3. Query the wiki

1. **Orient** (step 0).
2. `file_search` for relevant pages; `file_read` the best matches.
3. Synthesize an answer, citing pages with `[[links]]`. If the wiki can't
   answer it, say so (and offer to ingest a source that would).
4. If the answer is reusable, file it as a `type: query` page under `pages/`
   and add it to the index + log.

### 4. Lint (audit integrity) — run after every ingest, and on demand

```
skill_run({ skill: "knowledge-base", script: "lint", args: { root: "wiki" } })
```

It returns JSON: `clean`, `totalIssues`, `counts`, and arrays for
`brokenLinks`, `orphans`, `missingFromIndex`, `indexEntriesWithoutPage`,
`frontmatter`, `backlinkAsymmetry`, `oversized`, `stale`, `unknownTagsUsed`,
and `nonSlugFilenames`. Fix every issue with `file_write` / `file_patch`, then
re-run until `clean` is true:

- **brokenLinks** → create the missing page, or fix/remove the link.
- **orphans** → link the page from a related page (not just the index).
- **missingFromIndex / indexEntriesWithoutPage** → reconcile `index.md`.
- **frontmatter** → add the missing/invalid keys; ensure ≥2 outbound links.
- **backlinkAsymmetry** → add the reciprocal link where the relationship is real.
- **unknownTagsUsed** → add the tag to `SCHEMA.md`'s taxonomy first, or retag the page.
- **nonSlugFilenames** → rename to a lowercase-hyphen slug (rewrite the file at
  the new path and update links/index).
- **oversized** → split the page; **stale** → re-check the page against sources.

## Conflict handling

When a new source contradicts an existing page, do NOT silently overwrite:
check the dates, keep both positions with their sources if the contradiction is
real, set `contested: true` and `contradictions: [other-slug]` in frontmatter,
and call it out to the user for review.

## Rules

- **Orient before you write.** Always read SCHEMA + index + log tail first.
- **Never edit `raw/`.** It is the immutable source layer.
- **Always update `index.md` and `log.md`** — they are the wiki's navigation and history.
- **Frontmatter is mandatory** on every page; every tag must be in the taxonomy.
- **Lint after every ingest** and fix until clean.
- Keep pages scannable (< ~200 lines); handle contradictions explicitly.
