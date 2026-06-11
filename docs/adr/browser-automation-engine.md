# ADR: Browser Automation Engine — In-Process playwright-core, Not agent-browser

## Decision

Gini's agent-facing browser tools stay on the direct, in-process `playwright-core` integration in `src/tools/browser.ts`. We evaluated replacing it with [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) (June 2026, v0.27.x) and rejected adoption as an engine. agent-browser remains a design reference: several of its snapshot/ref ideas are worth porting into our own layer (see "Ideas worth porting" below).

## Context

agent-browser is Vercel's CLI for agent-driven browsing, and its pitch overlaps heavily with what `src/tools/browser.ts` does: compact text accessibility-tree snapshots with `@eN` element refs, snapshot-then-act interaction, persistent sessions, headed/headless, CDP attach. Published benchmarks show it producing ~80% smaller page representations than Playwright MCP, and it removes the Playwright dependency entirely (7 MB native binary vs ~700 MB of Node + browsers). The question was whether Gini should adopt it instead of maintaining ~3,000 lines of bespoke playwright-core integration.

Findings from source inspection (v0.27.1) and external research:

- **Architecture.** Since v0.20.0 agent-browser is 100% Rust — a thin CLI per invocation talking to a long-lived per-session Rust daemon over a Unix-socket JSON protocol; the daemon drives Chrome over raw CDP. No Playwright, no Node at runtime. It was originally a Node/Playwright daemon and has already been through one total rewrite.
- **Embedding model.** CLI-only. The npm package exposes only a `bin` entry — no `main`, no `exports`, no programmatic SDK; the Rust crate is a binary with no `[lib]`. Embedding means subprocess + `--json`, or speaking the daemon's internal, version-checked, undocumented socket protocol.
- **Snapshot/ref model.** Same shape as ours: CDP `Accessibility.getFullAXTree` rendered as an indented text tree, refs `e1..eN` assigned to interactive/content roles, addressed as `@eN` in subsequent commands. It adds refinements we lack (see below). Output budgeting is character-count-only and opt-in (`--max-output`); there is no default cap and no token-aware budgeting.
- **Security posture.** Opt-in domain allowlist (CDP `Fetch` interception), an action policy with confirm categories, an encrypted auth vault where the daemon fills credentials so the model never sees them, and content-boundary markers. But: no SSRF/private-IP/metadata-endpoint guard, no DNS-rebinding defense, no general secret redaction of page output, no audit trail, and no hook points where a host could add any of these — snapshot and screenshot content is produced inside the Rust core and handed to the caller as-is.
- **Stealth.** None built-in locally; `stealth` flags exist only for its cloud providers. It launches Chrome for Testing by default — exactly the identity [Browser Stealth Identity](browser-stealth-identity.md) exists to avoid — and equivalent stealth would be DIY `--args` flags without our branded-binary/UA-normalization machinery.
- **Maturity.** Repo created 2026-01-11; ~36k stars but effectively single-maintainer (36 of the last 50 commits by one Vercel engineer), `vercel-labs` experimental org, pre-1.0, issue backlog growing faster than closures (264 open vs 229 closed at evaluation time). Open bugs at evaluation time sat on exactly the two modes Gini depends on most: `--headed` silently ignored when the daemon is already running (the shape of our visible "Connect" sign-in flow), and `--cdp` attach ignored with a cluster of older CDP-attach failures.
- **Token efficiency.** The published ~80% savings are measured against Playwright MCP's verbose snapshots. Gini never had that baseline — our snapshots are already a compact `@eN` accessibility tree hard-capped at 32 KB — so the headline win does not transfer.

## Rationale

1. **The subprocess boundary is incompatible with our trust model.** Per [Browser Fill Secret](browser-fill-secret.md) and [Browser Stealth Identity](browser-stealth-identity.md), every string that leaves the browser layer passes through per-task + cross-task secret redaction, navigation passes through SSRF/DNS-rebinding pre-flight and post-redirect re-validation, screenshots go only to a vision side-call with pre-blur and post-OCR redaction, and uploads are approval-gated. All of that lives on in-process hooks into the Playwright session. agent-browser offers no interception points — adopting it means rebuilding the trust machinery as wrappers around opaque CLI text output, or weakening it.
2. **Its core innovation is one we already have.** The `@eN` ref snapshot model — the reason agent-browser wins benchmarks against Playwright MCP — is structurally what `src/tools/browser.ts` already produces, with budgeting agent-browser lacks (32 KB default cap, hidden-element budget, middle-out truncation).
3. **It is weakest exactly where we need the most reliability.** Headed connect for user sign-in and CDP attach to the user's own Chrome had open bugs at evaluation; our CDP-attach flakiness (playwright-core 1.60 + Bun) is better addressed by upgrading playwright-core than by swapping the engine for one with the same class of bug and no API contract.
4. **Dependency risk.** Pre-1.0, single-maintainer, experimental org, one rewrite already behind it — a poor foundation for a security-sensitive layer whose host has no programmatic contract with it.

agent-browser stays in our *development* workflow (driving the Next.js dev server for QA, per `CLAUDE.md`) — that use is interactive, low-trust, and plays to its strengths. This ADR is only about Gini's runtime browser tools.

## Ported designs

Verified in agent-browser's source; each stood alone as an improvement to `src/tools/browser.ts` without adopting the engine. All five are implemented there, inside the existing budgets and redaction passes:

1. **Cursor-interactivity augmentation** (`snapshot.rs`): a single injected JS pass that finds elements with `cursor: pointer`/`onclick`/`tabindex` that are *not* native interactive tags or ARIA roles (deduping inherited cursor styles), plus promotion of hidden label-wrapped radio/checkbox inputs that Chrome drops from the AX tree. Catches div-soup clickables a pure accessibility tree misses. Implemented as `[clickable]` snapshot entries under a per-snapshot clickable budget.
2. **Stale-ref self-healing** (`element.rs`): cache a node identity per ref; when resolution fails after a DOM re-render, re-query by role/name/nth instead of erroring. Refs survive re-renders; the model retries less. Implemented with mis-heal containment the source design lacks: candidates carrying a different ref stamp are rejected, text-matched candidates must themselves qualify as cursor-interactive, the verify-and-restamp runs as one atomic evaluate, and `browser_fill_secrets`/`browser_upload_file` never heal (trust boundary — see [Browser Fill-Secret Tool](browser-fill-secret.md)).
3. **Snapshot diffing** (`diff.rs`): post-action tools return a line diff against the previous snapshot when the change is small — large token savings in multi-step loops, directly relevant to the browser-loop context-overflow incident. Diffs compare post-redaction text only; explicit `browser_snapshot` always returns the full tree as the recovery path.
4. **Annotated screenshots sharing the ref namespace**: numbered badges on the `browser_vision` screenshot keyed to the same `@eN` refs, so vision answers can point at elements the model can act on. Badges carry only ref ids, cover only refs the session holds, and skip secret-stamped elements.
5. **Stable, never-reused tab handles** (`t1`, `t2`, …) instead of positional indices in `browser_tabs`.

## Downloads

`browser_download` captures a page-initiated file download (Playwright's `download` event around a click on an approved `@eN` ref) and saves it under the instance-scoped downloads directory (`paths.downloadsDir` → `~/.gini/instances/<inst>/downloads/`), so downloaded artifacts live and die with the instance like uploads do. Trust contract:

- **Approval-gated like `browser_upload_file`.** The dispatch routes through `resolveApprovalPolicy` as `browser.download` (gated under `strict`, auto-approved under `auto`/`yolo` per [approvalMode](approval-mode.md)), and the approved click runs in `agent.executeApprovedAction` with the same abort contract as upload: a `browser.download` / `browser.download_aborted` audit row at decision time, plus a `browser.download_late_completion` follow-up row if a detached download settles after a cancel.
- **No ref self-healing.** The approval names the exact stamped element; a lost stamp fails loudly instead of re-resolving (same stance as upload and `browser_fill_secrets`).
- **Size cap.** Saves above 50 MB (constant, test-injectable) are deleted and the call fails — the cap is enforced post-save because Playwright streams the download and the byte count isn't known up front.
- **Filename safety.** The server-suggested filename is attacker-controlled: it is reduced to a safe basename (separators/traversal stripped, control chars removed) and unique-ified on collision so downloads never overwrite each other.
- The result envelope (saved path, size, suggested filename) rides the standard `ok()`/`fail()` secret-redaction pass like every other browser tool result.

## Revisit triggers

- agent-browser ships a supported programmatic SDK (library entry point with hooks for output filtering and navigation policy).
- It reaches 1.0 with a stability commitment and the headed/CDP-attach bug class is demonstrably closed.
- Our playwright-core upgrade fails to fix CDP-attach flakiness under Bun, making a CDP-native engine worth the integration cost.

## Acceptance Checks

- `package.json` depends on `playwright-core` (no `agent-browser` runtime dependency); `src/tools/browser.ts` drives the browser in-process.
- Secret redaction, SSRF guards, snapshot budgets, vision side-call, and upload approval gating remain in-process hooks on the Playwright session (no subprocess boundary between page content and redaction).
- Any ported snapshot/ref improvement (cursor-interactive augmentation, ref self-healing, snapshot diff, annotated screenshots, stable tab handles) lands inside `src/tools/browser.ts` under the existing budgets and redaction passes.
