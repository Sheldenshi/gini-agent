---
name: people-crm
description: "Turn LinkedIn connections (or any contact export) into a queryable personal CRM using the agent database."
license: MIT
metadata:
  gini:
    version: 1.0.0
    author: Gini
---

# People CRM

Use your own database (`db_*` tools) to keep the user's professional network as structured, exhaustively-queryable records — import their connections once, then answer "who do I know at X", track who people are over time, and map who-knows-whom. This is the right tool because contact questions demand **complete** answers; long-term memory recall is a fuzzy sample and will miss people.

## When to Use

- The user gives you their LinkedIn connections (a `Connections.csv` export) or any contact/roster list and wants to "remember", "load", or "keep track of" their network.
- They ask to find / list / count people by company, role, location, or how they're connected ("who do I know at Stripe", "how many founders do I know", "who could introduce me to someone at Google").
- They describe a person to track ("add my friend Tom, he founded Acme", "Sara moved to Stripe as Head of Eng").

## When NOT to Use

- One-off facts with no roster ("remember my wife's birthday") → that's ordinary memory, not a CRM.
- A few unrelated notes about a single person where the user won't query across people.

## Getting the data in

LinkedIn → **Settings → Data Privacy → Get a copy of your data → Connections** emails a `Connections.csv`. When the user attaches it (or any CSV/XLSX), import it — do NOT read the rows into the chat and retype them:

```
db_import  path="uploads/<id>/Connections.csv"  table="contacts"
```

`db_import` skips the export's preamble lines automatically and creates columns from the header, so `contacts` ends up with: `first_name, last_name, url, email_address, company, position, connected_on` (all TEXT). Re-importing is safe with `recreate: true` to start clean. Confirm with `db_schema`.

> Tip: LinkedIn dates look like `05 Jun 2024`. If the user wants date-range queries, add an ISO column once: `db_execute "ALTER TABLE contacts ADD COLUMN connected_iso TEXT"` then populate it with an `UPDATE` using `substr`/`CASE` over `connected_on`.

## Querying the network (always exhaustive)

Use `db_query` — it returns every matching row. Each call runs ONE statement: pass each SQL below to its own `db_query` (reads) or `db_execute` (writes) call. `company` matching should be case-insensitive:

```sql
-- Everyone at Google (complete list, not a sample)
SELECT first_name, last_name, position FROM contacts WHERE company = 'Google' COLLATE NOCASE ORDER BY last_name;

-- How many at each company (top of the network)
SELECT company, COUNT(*) AS n FROM contacts WHERE company <> '' GROUP BY company COLLATE NOCASE ORDER BY n DESC;

-- Founders / leadership
SELECT first_name, last_name, company FROM contacts WHERE position LIKE '%Founder%' OR position LIKE '%Head of%' OR position LIKE '%VP%' COLLATE NOCASE;

-- Free-text "who was that person…"
SELECT * FROM contacts WHERE (first_name || ' ' || last_name) LIKE '%sokolov%' COLLATE NOCASE;
```

If a result comes back `truncated`, add `LIMIT`/`OFFSET` to page, or aggregate with `COUNT`.

## Tracking who a person is

When the user tells you about someone, write structured fields — find the row by name (or `url` if known) and update it, or insert a new person. Each statement is a separate `db_execute` call:

```sql
-- db_execute: update an existing connection
UPDATE contacts SET company = 'Stripe', position = 'Head of Eng', location = 'Berlin'
WHERE first_name = 'Sara' AND last_name = 'Lindqvist'
```
```sql
-- db_execute (one-time): add a notes column for free-text color; ignore the error if it already exists
ALTER TABLE contacts ADD COLUMN notes TEXT
```
```sql
-- db_execute: add someone who wasn't in the import
INSERT INTO contacts (first_name, last_name, company, position, notes)
VALUES ('Tom', 'Greco', 'Acme', 'Founder', 'Met at a conference; strong in fintech.')
```

If the name matches more than one row, show the user the candidates and ask which one before updating.

## Relationships (who knows whom)

LinkedIn exports don't include who your connections know each other — that comes from the user. Keep edges in their own table and answer graph questions with a JOIN. Run each statement as a separate call (`db_execute` for the first two, `db_query` for the reads):

```sql
-- db_execute: create the edges table once
CREATE TABLE IF NOT EXISTS relations (a TEXT, b TEXT, kind TEXT, note TEXT)
```
```sql
-- db_execute: "Maya and Sam worked together at Amazon"
INSERT INTO relations (a, b, kind, note) VALUES ('Maya Park', 'Sam Bauer', 'colleague', 'Amazon')
```
```sql
-- db_query: who is connected to Maya?
SELECT b AS other, kind, note FROM relations WHERE a = 'Maya Park'
UNION SELECT a, kind, note FROM relations WHERE b = 'Maya Park'
```
```sql
-- db_query: mutual connections of two people (who could intro them)
SELECT r1.b AS mutual FROM relations r1 JOIN relations r2 ON r1.b = r2.b
WHERE r1.a = 'Sam Bauer' AND r2.a = 'Carlos Lindgren'
```

(Use full names consistently, or store each person's `contacts` rowid in `relations` for exactness.)

## Rules

1. Always import with `db_import` — never retype rows from a file.
2. For "find / list / how many" use `db_query`, never `recall_memory` — contact questions need complete answers.
3. Confirm before bulk-updating or deleting rows.
4. Don't scrape LinkedIn for anything the imported table can answer.
