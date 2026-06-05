# ADR: People-CRM Contacts Store

- **Status:** Accepted
- **Date:** 2026-06-05
- **See also:** [Per-Agent Memory Isolation](./agent-memory-isolation.md), [Memory](../memory.md)

## Decision

Contacts (people the user tracks as a network — the LinkedIn-import use case)
live in a dedicated structured store, **not** in Hindsight memory. Two
agent-scoped tables, `contacts` and `contact_relations`, sit alongside Hindsight
in the per-instance `memory.db` (schema version 10). They are queried with plain
SQL `WHERE` / `COUNT` that returns **every** matching row (cursor-paginated),
with no ranking, reranking, or token budget.

Six agent tools expose the store — `contacts_import`, `contacts_query`,
`contacts_count`, `contacts_upsert`, `contacts_relate`, `contacts_relations` —
gated by an enabled-by-default `contacts` toolset. The same operations are
exposed over `/api/contacts*` and the `gini contacts` CLI. The smart upsert /
relate / reference-resolution logic lives in `src/contacts` so the tool, API,
and CLI share one implementation.

## Context

The memory system (Hindsight) is, by design, an **associative recall engine**:
semantic + BM25 + graph + temporal channels fused by reciprocal-rank fusion,
reranked over the top candidates, and packed into a token budget (`SEMANTIC_TOP_K
= BM25_TOP_K = GRAPH_TOP_K = 50`, rerank top-25, `DEFAULT_TOKEN_BUDGET = 2000`).
This is the right shape for "what do I know about Alice?" — it surfaces the most
relevant facts and stops.

It is the wrong shape for a CRM. The core CRM promise is the **exhaustive**
query: "find every person who works at Google." On a recall pipeline that is
irreducibly top-K / fuzzy / budget-capped, that question returns a relevance
ranked *sample* with a hedge — it silently undercounts. No prompt tuning fixes a
top-K pipeline; exhaustiveness requires a non-ranked `SELECT … WHERE` that
returns all rows. Separately, the `entities` table carried no attributes (only
`canonical_name` + `entity_type`), so CRM fields (company, title, location,
profile URL, connected date) had nowhere structured to live, and no agent tool
enumerated the entity store.

These are fundamentally different access patterns, identity models, and
lifecycles:

| | Hindsight memory | Contacts CRM |
|---|---|---|
| Access | associative, ranked, top-K, budgeted | exhaustive relational query, return-all |
| Identity | fuzzy lexical / co-occurrence merge | stable external key (LinkedIn URL, email) |
| Lifecycle | extract → decay → rerank | explicit create / update / dedup / list |

Overloading Hindsight with attribute columns and a non-ranked query path would
fight the retrieval philosophy and risk a roster of thousands of people flooding
the embedding index and entity-link graph, degrading normal recall. The project
boundary rules already mandate bounded domain modules under `src/<domain>` with
storage in `src/state/*`; a `contacts` module is the idiomatic fit.

## Required Now

- **Storage** (`src/state/contacts-db.ts`, DDL in `memory-db.ts`):
  - `contacts(id, agent_id, full_name, first/last_name, company, title,
    location, email, linkedin_url, connected_at, source, notes, metadata,
    timestamps)`. Indexes on `(agent_id, company)`, `(agent_id, location)`,
    `(agent_id, last_name)`; partial `UNIQUE(agent_id, linkedin_url)` enforces
    one row per profile while leaving URL-less rows unconstrained (exports often
    omit it).
  - `contact_relations(agent_id, from_contact_id, to_contact_id, relation_type,
    note, source, created_at)` with `ON DELETE CASCADE` and a reverse index on
    `to_contact_id`.
  - Everything scoped by `agent_id` (the per-agent memory namespace), matching
    [agent-memory-isolation.md](./agent-memory-isolation.md).
- **Exhaustive query semantics:** `queryContacts` / `countContacts` run plain
  SQL with no top-K and no token budget. Exact filters use `= ? COLLATE NOCASE`;
  free-text uses `LIKE` with escaped wildcards (literal `%`/`_` match
  literally). Results are cursor-paginated (`limit`/`offset`, default 500 / max
  2000) with `total` + `hasMore` so a caller can page to completeness.
- **Identity / dedup:** import upserts dedup on `linkedin_url` then `email`. The
  chat/API upsert resolves `id → linkedin_url → email → name`; a supplied URL is
  authoritative — a URL miss creates a new person rather than name-merging two
  distinct profiles that share a name. An ambiguous name returns the candidate
  set instead of guessing.
- **Deterministic import** (`src/contacts/import.ts`): a quote-aware CSV parser
  + LinkedIn-aware header detection (skips the export's preamble) + Connected-On
  date normalization, upserting one row per person and returning an exact
  created/updated/skipped report. XLSX/XLS is converted via the existing `xlsx`
  dependency. This bypasses the chat-attachment inline-text cap and the lossy
  LLM-summarization retain path entirely — one input row in, one contact out.
- **Agent instructions** steer the model to use `contacts_*` (exhaustive) for
  find/list/count/who-works-at questions and never `recall_memory` for roster
  completeness; to import roster files rather than memorizing rows; and not to
  scrape LinkedIn for what the store can answer.

## Consequences

- "Find/count all people where X" is reliable and complete; the agent answers
  from the local store across sessions without re-reading a file or scraping.
- Contacts writes are low-risk / no-approval, matching the auto-retain
  memory-write model — local, reversible, explicitly user-requested.
- Hindsight stays the home for free-text color about a person; `notes` on the
  contact row carries durable structured commentary. The two stores are
  complementary, not redundant: structured/exhaustive vs. associative/fuzzy.
- New surfaces (web/mobile) get the CRM for free via `/api/contacts*`.

## Acceptance Checks

- `bun test src/state/contacts-db.test.ts src/contacts/import.test.ts
  src/execution/contacts-dispatch.test.ts src/contacts-http.test.ts` pass.
- Importing a LinkedIn `Connections.csv` and asking, in a fresh chat, "how many
  connections work at Google? list them all" returns the complete set via
  `contacts_query` (verified in dogfooding), where the pre-store behavior
  returned a fuzzy partial and fell back to browser scraping.
- A contact's company update is reflected in subsequent company queries (the
  Google count drops when a person moves), proving structured-field mutation
  rather than additive memory.
