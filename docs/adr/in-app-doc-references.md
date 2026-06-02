# ADR: In-App Doc References Render Inline

- **Status:** Accepted
- **Date:** 2026-06-02
- **See also:** [Provider Re-Authentication Guidance](provider-reauth-guidance.md), [ChatBlock Protocol](chat-block-protocol.md), [Connector-Backed Web Search](web-search-connectors.md)

## Decision

When the app references a specific piece of hosted documentation
(`https://gini.lilaclabs.ai/docs/<path>#<anchor>`), it renders that doc section
**inline** in a slide-over panel instead of opening a new browser tab. An
**Open full docs ↗** link to the complete hosted page stays as an escape hatch.

The mechanism is reusable for any "see this doc" reference, not special-cased to
provider re-auth:

- **Content source — the gateway.** The repo's top-level `docs/` directory IS
  the source of the hosted site's content, and the gateway always runs from the
  repo checkout, so `docs/` is always present at `projectRoot()`. The gateway
  serves it directly; the client never fetches or scrapes the external HTML
  site. This is robust (no dependency on the external site being reachable,
  always in sync with the running version, works offline) and a future mobile
  client gets it for free via the same endpoint.

- **Endpoint — `GET /api/docs/<path>?section=<slug>`.** Returns
  `{ path, title, markdown, anchor? }`. `src/docs.ts` reads the `.md` under
  `docsRoot()` (confined by `assertInsideWorkspace`, only `.md` served), parses
  the H1 for `title`, and — when a `section` slug is given — returns just that
  section: the slice from the matching heading through the line before the next
  heading of the same-or-higher level, with deeper sub-headings included. The
  slug rule is GitHub-style (`slugifyHeading`), so a hosted URL's
  `#re-authentication` fragment resolves to the same section. Heading scanning
  ignores fenced code blocks. A missing section degrades to the full doc rather
  than erroring; a missing doc is a 404; a confinement failure is a 400. The
  central bearer gate covers the route. Keeping section extraction and the slug
  algorithm on the gateway centralizes one implementation (reusable by mobile)
  and keeps the payload small.

- **Contract — the runtime still owns the URL.** `ProviderReauth`,
  `SystemNoteAuthError.reauthUrl`/`reauthKind`, the connector `docsUrl` field,
  and every persisted chat-block shape keep carrying the full hosted URL. The
  web `DocReference` component derives the relative gateway path (+ anchor) from
  that URL (everything after `/docs/` in the pathname) and uses the original URL
  as the **Open full docs ↗** target. So there are no runtime/type/serialization
  changes, old persisted notes keep working, and the component drops in anywhere
  a hosted docs URL already exists.

- **Component — one reusable `DocReference`.** `<DocReference url={hostedUrl}>`
  wraps any trigger. It fetches the section lazily on open via the `api()` proxy
  and renders the markdown by reusing the chat `MarkdownContent` renderer. When
  the URL is not a `/docs/` URL it falls back to a plain external link, so a
  reference can never break. The two current consumers are the codex re-auth CTA
  (`BlockSystemNote`) and the connector **Learn more** link
  (`AddConnectorDialog`); arbitrary links inside assistant chat text are out of
  scope and keep opening in a new tab.

## Consequences

- A new app-referenced doc needs only a hosted docs URL and a `<DocReference>`
  wrapper — no new endpoint, no contract change, no per-consumer component.
- The same `GET /api/docs` endpoint serves a future mobile client.
- Doc anchors are authored in-repo; a stale anchor degrades to the whole doc
  inline rather than erroring.

### Acceptance checks

- `GET /api/docs/providers/codex?section=re-authentication` returns
  `title: "Codex"` and markdown containing `## Re-authentication` plus the
  nested `### If you authenticate with OPENAI_API_KEY instead` sub-section.
- `GET /api/docs/search/brave` (no section) returns the full body with the
  leading `# Brave Search` H1 stripped.
- An unauthenticated request is 401; a traversal path is 400; a missing doc is
  404.
- Clicking the codex re-auth CTA opens the `#re-authentication` section inline
  with a working **Open full docs ↗** link; opening the Add Connector dialog for
  Brave/Exa renders the doc inline from **Learn more**.

## Related

- [Provider Re-Authentication Guidance](provider-reauth-guidance.md)
- [ChatBlock Protocol](chat-block-protocol.md)
- [Connector-Backed Web Search](web-search-connectors.md)
