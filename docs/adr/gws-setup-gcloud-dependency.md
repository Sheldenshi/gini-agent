# ADR: `gcloud` As An Optional Accelerator For Google Workspace Setup

- **Status:** Accepted
- **Date:** 2026-05-20
- **See also:** [Skills As Packages, Connectors As Credentials](./skills-and-connectors.md), [Browser Toolset Enabled By Default](./browser-default-toolset.md), [Approval And Audit Substrate](./approval-and-audit-substrate.md)

## Decision

The `google-workspace-setup` skill carries **two parallel setup paths** and picks one at runtime based on whether `gcloud` is installed on the user's machine:

- **gcloud-hybrid (fast path, ~1-2 min).** `gcloud projects create` provisions the GCP project; a single `gcloud services enable` call enables all six Workspace APIs in parallel; the browser is opened only for the OAuth consent screen and Desktop client creation (the two Cloud Console pages Google does not expose programmatically).
- **Browser-only (fallback, ~5 min).** The path that shipped before this ADR. Every Cloud Console page is driven through the `browser_*` tools end-to-end.

`gcloud` is an **optional dependency** of the skill, not a hard requirement. The skill detects `gcloud` via `command -v gcloud` and prompts the user before installing it (`brew install --cask google-cloud-sdk` on macOS, the official installer elsewhere). Users who decline land on the browser-only path; the end state of both paths is identical (Desktop OAuth client JSON at `~/.config/gws/client_secret.json`, six Workspace APIs enabled, consent screen configured with the user as a test user).

## Context

The browser-only path shipped first because it removes every external dependency from the setup story — Gini has a browser toolset, Cloud Console runs in a browser, the user already trusts Gini to drive that browser for them. It works. It is slow because Cloud Console's project-creation and per-API-enablement pages each take a couple of seconds to load plus a click or two, and six APIs times ~30 seconds each is the dominant cost in the setup timeline.

Two observations triggered the gcloud-hybrid work:

1. **`gcloud projects create` and `gcloud services enable` together replace the slowest ~3 minutes of the browser flow with two terminal commands that take under a minute combined.** The wire cost of "create a project and enable six APIs" is tiny; the Cloud Console UI's per-page overhead is what makes the browser path slow. Hitting the same APIs directly through `gcloud` skips that overhead entirely.
2. **A subset of users already have `gcloud` installed** (existing Cloud Engineers, anyone who's deployed to App Engine or Cloud Run, anyone who's followed a Workspace API quickstart). For those users, requiring the slow browser path is an unforced loss.

A spike confirmed the precise scope of what `gcloud` can and cannot do here.

## What `gcloud` Actually Covers

Verified via the official Google Cloud documentation:

- **`gcloud auth login`** — opens the user's default browser for Google sign-in. Works for personal `@gmail.com` and Workspace tenant accounts alike. Credentials land on the local machine; Gini never sees them.
- **`gcloud projects create <id>`** — works for personal Gmail accounts. No billing account required for project creation (Workspace API usage is free under the standard quotas). Personal accounts have a default project quota; the skill surfaces `ALREADY_EXISTS` / quota errors verbatim and asks the user to pick a different name.
- **`gcloud services enable <id1> <id2> ...`** — accepts all six Workspace API IDs in one call and enables them in parallel. The exact IDs (some of which are non-obvious):
  - `gmail.googleapis.com`
  - `calendar-json.googleapis.com` (NOT `calendar.googleapis.com`)
  - `drive.googleapis.com`
  - `docs.googleapis.com`
  - `forms.googleapis.com`
  - `meet.googleapis.com` (the Meet REST API)
- **`gcloud config set project <id>`** — switches the active project for subsequent calls.

## What `gcloud` Does NOT Cover

The spike's important null finding: **Google does not expose a public API for either the OAuth consent screen or Desktop OAuth client creation.**

- **`gcloud iap oauth-brands create` and `gcloud iap oauth-clients create`** look like they should be the right primitives, but the Google Cloud documentation is explicit: "The OAuth clients created by the API are locked for IAP usage only, and therefore the API does not allow any updates to the redirect URI or other attributes." These commands produce clients usable only with Identity-Aware Proxy-protected web resources in Workspace organizations. They cannot be repurposed for Desktop OAuth clients. They also have restricted availability for personal Gmail accounts (IAP is a Workspace organization feature).
- **The standard OAuth consent screen** has no documented programmatic configuration path. Google's official guide describes only the Cloud Console UI flow. Workspace-tenant administrators can use Cloud Identity APIs to manage some app metadata, but the per-project consent screen for personal accounts is browser-only.
- **OAuth Desktop client creation** has no public API. Multiple Google documentation pages and the official credentials guide state that Desktop client credentials must be created through the Cloud Console UI.

So gcloud-hybrid is **hybrid** by necessity: project creation + API enablement are programmatic; consent screen + Desktop client creation are not. The browser still has to come up for the last two steps. The win is that the browser session is short (~30 seconds for two pages) rather than long (~5 minutes for six pages).

If Google publishes a public OAuth-client-management API in the future, gcloud-hybrid can absorb those steps and shrink the browser session to zero. The skill's structure already isolates the browser-driven section (Milestones D and E in Step 2A) so a follow-up can replace those milestones with `gcloud` calls without restructuring the rest of the flow.

## Why Optional, Not Required

Three reasons gcloud-hybrid is not the only path:

1. **Disk and install cost.** `gcloud` is ~60MB compressed (verified against the official installer docs). For users who only want one Workspace skill to work once, installing 60MB of GCP tooling is disproportionate. The browser-only path has zero new install footprint beyond what Gini already ships.
2. **Privacy-sensitive operating environments.** Some users (regulated industries, security-conscious orgs) prefer not to install Google's Cloud SDK on their machine at all, even when they're happy to use a Workspace skill that talks to Google's APIs. The browser-only path serves them without compromise.
3. **The browser path is already the trust foundation.** The user already trusts Gini to drive a browser for them as of ADR `browser-default-toolset.md`. Adding `gcloud` doesn't expand the trust surface in a meaningful way (both paths put the user's GCP credentials on the local machine), but requiring `gcloud` would force an extra install on every Gini user the first time they touch Workspace.

The default UX is "ask the user once, default to the fast path when they have it, fall back gracefully when they don't." Not "install GCP tooling on every machine."

## Privacy Invariants That Survive

Both paths preserve the same privacy property the original browser-only path established:

- **OAuth Desktop client lives in the user's own GCP project.** `gcloud projects create` runs under the user's own Google credentials; the project is theirs, not Gini's. The Desktop client created in Milestone E is bound to that project.
- **No Gini-operated server in the data path.** Every `gws` call uses the user's local OAuth tokens to talk to Google directly. Gini's runtime never proxies the data plane.
- **`gcloud` credentials never leave the local machine.** `gcloud auth login` writes the user's authorized-user credentials to `~/.config/gcloud/` on the user's machine. Gini's runtime invokes `gcloud` as a local subprocess via `terminal_exec`; the credentials are never serialized to a Gini-controlled store or remote endpoint.
- **Tokens never reach Gini's chat history.** The post-OAuth credentials `gws` writes to `~/.config/gws/` are AES-256-GCM encrypted at rest with the key in the OS keyring (or a local fallback file). The `client_secret.json` is plaintext OAuth client config — sensitive but identifies only the app, not the user.

The new privacy surface gcloud-hybrid introduces is bounded: the user installs Google's official Cloud SDK on their own machine and signs into it with their own Google account. That's the same trust shape as installing any other Google client tool.

## Composition With `browser-default-toolset.md`

Both paths use the `browser_connect` tool surface introduced by ADR `browser-default-toolset.md`. The trust-boundary semantics for that surface are unchanged by this ADR:

- **Step 2A (gcloud-hybrid)** uses `browser_connect` briefly — only for Milestones D and E, the two Cloud Console pages that need the browser. Two `browser_connect` approval cards (one for D, one shared with E since the same session covers both) is the upper bound; the user can also `browser_close` between them if they prefer.
- **Step 2B (browser-only)** uses `browser_connect` extensively, with the headed-then-headless dance documented in ADR `browser-default-toolset.md`'s Milestone A.5 section of the skill body. Three approval cards total (initial visible connect, headless reconnect, optional headed-fallback if bot detection trips).

In both paths, the seven approval-skipping browser actions (`browser_click`, `browser_type`, `browser_drag`, `browser_select_option`, `browser_tabs.{open,switch,close}`) operate under the action-argument-trail trust model. The two approval-gated browser actions (`browser_upload_file` and `browser_connect` itself) remain gated. The composition is "ADR `browser-default-toolset.md` defines what the browser surface costs trust-wise; this ADR uses less of that surface when `gcloud` is available."

`gcloud` itself runs through `terminal_exec`, which is approval-gated by default. Users who run setup often (e.g. operators running it for multiple Gini instances) can opt into `gcloud *` in their `autoApproveCommands` to skip the per-invocation approval — but that's a user choice, not a default. The approval audit trail still fires either way.

## Required Now

- `skills/google/google-workspace-setup/SKILL.md` carries the two-path structure: Step 2 detects `gcloud`, Step 2A is gcloud-hybrid, Step 2B is browser-only.
- Manifest version is bumped to `2.0.0` to reflect the major restructure (new optional dependency, fundamentally different fast path).
- The all-six-APIs rule (every setup run enables Gmail, Calendar, Drive, Docs, Forms, Meet — not just the one the user's current ask needs) applies to both paths. Step 2A's `gcloud services enable` accepts all six in one call; Step 2B's Milestone C loops through all six in Console.
- Step 1.5 (existing client_secret.json shortcut) carries the same dual-mode treatment: if `gcloud` is available, the API-verification sub-step runs `gcloud services enable` against the existing project; otherwise it browser-drives Console.

## Open Questions

- **Workspace tenant OAuth client APIs.** A user on a paid Google Workspace tenant *may* be able to use Cloud Identity APIs for some app-registration management. The current skill treats all accounts as if they have to drive Console for OAuth client creation; a future revision could detect Workspace-tenant accounts and use the tenant-side APIs where available.
- **`gcloud iap oauth-clients` for Workspace tenants only.** For users on a Workspace tenant who deploy IAP-protected web apps, `gcloud iap oauth-brands` and `gcloud iap oauth-clients` are usable — but those produce web clients, not Desktop clients, and the `gws` CLI needs Desktop credentials. A separate skill (or a future expansion of this one) covering IAP web-app deployment would be a different scope.
- **`gcloud` install via skill.** Today the skill offers `brew install --cask google-cloud-sdk` on macOS and points at the official installer for other platforms. A future helper could install `gcloud` via the official tarball on every platform for parity, but the Homebrew cask is preferred where available because it integrates with the user's existing package manager.

## Acceptance Checks

- A fresh setup run with `gcloud` absent and the user declining install completes via Step 2B and ends with a Desktop client JSON at `~/.config/gws/client_secret.json`, all six APIs enabled, and a successful `gws drive files list --params '{"pageSize":1}'` smoke test.
- A fresh setup run with `gcloud` present completes via Step 2A and ends with the same artifacts in the same locations.
- The Step 1.5 reuse path with an existing `client_secret.json` verifies all six APIs are enabled in the user's existing project, using `gcloud services enable` if `gcloud` is available and browser-driving Cloud Console otherwise.
- The privacy property holds for both paths: no GCP credentials, OAuth tokens, or project metadata reach Gini's chat history, audit trail, or any remote endpoint Gini operates.
- The browser session in Step 2A is bounded to Milestones D and E (consent screen + Desktop client). The session in Step 2B covers Milestones A through F.

## Consequences For Coding Agents

- New Workspace skills that need additional GCP setup (e.g. a future BigQuery skill needs project + dataset creation) should follow the same shape: write a `gcloud`-fast path, keep a browser-driven fallback, detect at runtime. Do not assume `gcloud` is present.
- If Google publishes a public OAuth Desktop client management API in the future, replace Milestones D and E in Step 2A with `gcloud` calls. The skill's structure already isolates those milestones; no other section needs to change.
- The `command -v gcloud` detection idiom is the canonical pattern for "do I have this optional CLI installed." Future skills that take a similar shape (e.g. an AWS skill that uses `aws` when available, falls back to browser-driving the console) should mirror it.
- Future ADRs about Workspace-tenant-specific APIs (Cloud Identity, IAP-for-internal-apps, organization policies) should cite this ADR as the precedent for "personal Gmail accounts fall back to browser; Workspace tenants may have richer programmatic options."
