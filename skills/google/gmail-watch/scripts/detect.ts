#!/usr/bin/env bun
// gmail-watch detection engine — the deterministic email-watch detection floor,
// as a STATELESS, headless skill script (ADR email-watch.md).
//
// Provisioned + trusted: this script is shipped in-tree and run by the generic
// `skill-script` hook handler with no agent turn and no approval. It is the hook
// BODY for the ONE shared email-watch scheduled job (one job + one thread for all
// of an agent's watched senders).
//
// Contract:
//   stdin:  JSON { watches: [{ watcherId, query, account? }, ...], state: { byWatcher? } | null }
//   stdout: JSON { kind, items?, summary?, state: { byWatcher } }
//   exit:   0 always (a gws/transport / signed-out condition is reported PER WATCH
//           as a status in that watch's state, never a non-zero exit, so the
//           backing job stays alive and the email read path can derive each
//           watcher's displayed status)
//
// It iterates the watches and, for each, polls `gws` for new matching message ids,
// dedups against that watch's caller-supplied state (cursor + a tiny boundary
// `seen` set), applies a deterministic safety floor (drop automated senders +
// self), and emits the raw metadata (From/Subject/Date/snippet) of each surviving
// NEW match as an untrusted item — it reads ONLY metadata, never message bodies,
// and emits NO fence (the trusted hook runner fences untrusted items). Each watch
// is wrapped in its OWN try/catch so one sender's gws fault marks only that
// watch's status and the others still run. The script is a PURE function of
// {watches, state}: it never touches files or a DB; the new per-watch cursor +
// seen set ride back on the result keyed by watcherId and the caller persists them.

import { spawn } from "bun";

// ── Tunables (ported verbatim from the original delta engine) ────────────────

// Bound the gws spawn. A `messages list` / `messages get` is a single Gmail API
// round-trip — sub-second in practice. Cap it so a wedged child, a slow
// `zsh -lc` profile, or a token-refresh network stall can't pin the tick.
const SPAWN_TIMEOUT_MS = 15_000;

// Cap the draft items collected per tick. A fully-enumerated (non-truncated)
// window is drained oldest-first, but only up to this many matches in a single
// tick; the rest drain over successive ticks as the cursor advances.
const MAX_MESSAGES_PER_TICK = 25;

// Per-page result size for the paginated window list. Combined with
// WINDOW_PAGE_LIMIT this bounds how much of the window a single tick enumerates.
const WINDOW_PAGE_SIZE = 100;

// Max pages `--page-all` walks per tick. When this cap is hit the window can't be
// enumerated oldest-first (the older tail isn't listed), so detect baselines past
// it rather than draining.
const WINDOW_PAGE_LIMIT = 10;

// ── Types ────────────────────────────────────────────────────────────────────

interface DetectState {
  // Watermark: internalDate (epoch ms, as a string) of the newest processed
  // message. Undefined => seeding (first run).
  cursor?: string;
  // Tiny dedup set: the message ids sharing the cursor's exact epoch second.
  // Gmail's `after:` is second-granular and inclusive, so those ids get
  // re-listed every tick; this set drops them. The `after:` watermark keeps it
  // bounded to one second's worth of mail.
  seen?: string[];
  // Watcher health, carried IN the opaque state blob so the job persists it onto
  // hookState and the email read path can derive the watcher's displayed status
  // from it (the generic skill-script handler can't write watcher state). "ok" =
  // last tick polled cleanly; "needs_auth" = the gws session is signed out;
  // "error" = a gws/transport fault on the last tick.
  status?: "ok" | "needs_auth" | "error";
  // Scrubbed last-error message when status === "error" (cleared on "ok").
  lastError?: string;
}

interface DetectArgs {
  query: string;
  account?: string;
  // The explicitly watched sender address. Mail from EXACTLY this address
  // bypasses the automated-sender heuristic (the user asked for it by name);
  // self is still always dropped.
  sender?: string;
  // The user's standing instructions for this watch. Validated config from
  // the trusted tool/API channel (same trust level as the job prompt) —
  // emitted as ONE TRUSTED item on ticks where this watch matches, NEVER
  // inside the untrusted fence, and never sourced from email content.
  objective?: string;
  state?: DetectState | null;
}

// One declarative watch in the shared job's hook config: a stable watcher id +
// the Gmail query (and an optional account, recorded for the multi-account
// future, plus the explicitly watched sender when one drove the query). The
// shared job carries a LIST of these, rebuilt from the enabled watchers on
// every add/remove/enable/disable.
interface Watch {
  watcherId: string;
  query: string;
  account?: string;
  sender?: string;
  objective?: string;
}

// The shared job's multi-watch input: the list of enabled watches + the opaque
// per-watch state keyed by watcherId.
interface DetectArgsMulti {
  watches?: Watch[];
  state?: { byWatcher?: Record<string, DetectState> } | null;
}

// The shared job's multi-watch output: all surviving matches across the watches
// as untrusted items (labeled by sender), an optional non-silent summary (the
// per-watch backlog notices joined), and the new per-watch state keyed by
// watcherId for the caller to persist.
interface DetectResultMulti {
  kind: "shortCircuit" | "context";
  items?: ResultItem[];
  summary?: string;
  state: { byWatcher: Record<string, DetectState> };
}

interface EmailMetadata {
  id: string;
  internalDate?: string; // epoch ms, as gws returns it
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
}

// A single injectable context item, matching the hook runner's HookContextItem.
interface ResultItem {
  text: string;
  untrusted: boolean;
}

interface DetectResult {
  kind: "shortCircuit" | "context";
  items?: ResultItem[];
  summary?: string;
  // Health rides in `state.status`/`state.lastError` (the opaque blob the job
  // persists), so the email read path can derive the watcher's displayed status.
  // A transport problem is a shortCircuit with status:"error", never a non-zero
  // exit, so the backing job keeps polling and recovers on the next clean tick.
  state: DetectState;
}

// ── gws subprocess boundary (injectable for the unit test) ───────────────────

export type GwsSpawn = (args: string[]) => Promise<string>;

// Default gws spawn: `zsh -lc "gws ..."`, stdin ignored, kill-on-timeout,
// inheriting the env the skill-script runner provides (PATH/HOME + GINI_*). gws
// reads its own client config + token from ~/.config/gws/, so no credentials are
// injected. stdout AND stderr are drained CONCURRENTLY: a piped stream that is
// never read can fill its OS buffer (~64KB) and deadlock the child until the
// kill timer fires; gws emits its keyring preamble to stderr.
export async function defaultGwsSpawn(args: string[]): Promise<string> {
  const proc = spawn(["zsh", "-lc", `gws ${args.join(" ")}`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env }
  });
  const timeout = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, SPAWN_TIMEOUT_MS);
  try {
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    return stdout;
  } finally {
    clearTimeout(timeout);
  }
}

// ── gws arg builders + parsers (ported verbatim) ─────────────────────────────

// Single-quote a JSON params object for the gws CLI. The values are integers /
// fixed query strings the engine builds (never raw email content), so no
// untrusted bytes reach the shell here.
function jsonParam(obj: Record<string, unknown>): string {
  return `'${JSON.stringify(obj)}'`;
}

function buildAuthStatusArgs(): string[] {
  return ["auth", "status"];
}

// Gmail lists newest-first within and across pages; `--page-all` walks up to
// `--page-limit` pages and emits one JSON object PER PAGE (NDJSON). We enumerate
// the whole window so the oldest-first drain never advances the cursor past an
// un-listed match.
function buildListArgs(query: string): string[] {
  return [
    "gmail", "users", "messages", "list",
    "--params", jsonParam({ userId: "me", q: query, maxResults: WINDOW_PAGE_SIZE }),
    "--format", "json",
    "--page-all",
    "--page-limit", String(WINDOW_PAGE_LIMIT)
  ];
}

function buildGetArgs(messageId: string): string[] {
  return [
    "gmail", "users", "messages", "get",
    "--params", jsonParam({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"]
    })
  ];
}

function buildProfileArgs(): string[] {
  return ["gmail", "users", "getProfile", "--params", jsonParam({ userId: "me" })];
}

// gws prints a "Using keyring backend: keyring" preamble to STDERR before the
// JSON. With the concurrent stdout/stderr drain stdout begins at the first `{`;
// the leading-`{` skip below is a defensive guard. Returns undefined on any parse
// failure (a garbled CLI is treated as "no data" rather than crashing the tick).
function parseGwsJson(stdout: string): Record<string, unknown> | undefined {
  const start = stdout.indexOf("{");
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

interface MessageListWindow {
  ids: string[];
  pageLimitHit: boolean;
}

// Parse a `messages list --page-all` response (NDJSON: one JSON object PER PAGE)
// into the ordered window (newest-first, as Gmail returns them) plus whether the
// page cap was hit. Falls back to single-object parsing so a non-paginated
// response still works; any stray non-JSON line (the preamble) is skipped.
function parseMessageWindow(stdout: string): MessageListWindow {
  const ids: string[] = [];
  let pages = 0;
  let lastPageHadToken = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let doc: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(trimmed);
      doc = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      continue;
    }
    if (!doc) continue;
    pages += 1;
    lastPageHadToken = typeof doc.nextPageToken === "string" && doc.nextPageToken.length > 0;
    const messages = doc.messages;
    if (!Array.isArray(messages)) continue;
    for (const m of messages) {
      if (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string") {
        ids.push((m as { id: string }).id);
      }
    }
  }
  return { ids, pageLimitHit: pages >= WINDOW_PAGE_LIMIT && lastPageHadToken };
}

// Parse a `messages get format=metadata` response into EmailMetadata.
function parseMessageMetadata(stdout: string, id: string): EmailMetadata {
  const doc = parseGwsJson(stdout);
  const meta: EmailMetadata = { id };
  if (!doc) return meta;
  if (typeof doc.internalDate === "string") meta.internalDate = doc.internalDate;
  if (typeof doc.snippet === "string") meta.snippet = doc.snippet;
  const payload = doc.payload as { headers?: unknown } | undefined;
  const headers = payload?.headers;
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (!h || typeof h !== "object") continue;
      const name = (h as { name?: unknown }).name;
      const value = (h as { value?: unknown }).value;
      if (typeof name !== "string" || typeof value !== "string") continue;
      const key = name.toLowerCase();
      if (key === "from") meta.from = value;
      else if (key === "subject") meta.subject = value;
      else if (key === "date") meta.date = value;
    }
  }
  return meta;
}

// ── Error scrub (ported verbatim) ────────────────────────────────────────────

// Scrub a gws/transport error message before it rides back in state.lastError
// and surfaces in the watcher status. Redact credential-bearing file paths
// (config/keyring/token files) and any home-rooted path so a leaked stack frame
// or CLI diagnostic can't expose the operator's filesystem layout. Two passes:
//   - explicit .json/.enc secret files;
//   - any /Users/<u>, /home/<u>, or /root path (anchored so /root doesn't eat
//     /rootcause). Over-redaction is the safe direction for an error string.
export function scrubError(message: string): string {
  return message
    .replace(/[^\s'"]*\.(?:json|enc)/g, "<path>")
    .replace(/(?:\/Users\/[^/\s'"]+|\/home\/[^/\s'"]+|\/root(?=\/|$|[\s'"]))(?:\/[^\s'"]*)?/g, "<path>");
}

// ── Safety floor (ported verbatim) ───────────────────────────────────────────

// Drop automated senders or the user's own address. Bodies aren't available, so
// the heuristic is From-based (drop automated + self at the trigger).
const AUTOMATED_FROM = /no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?@|noreply/i;

// Extract the bare address from a From header — the `<addr@host>` form when
// present, else the first bare `addr@host` token, lowercased.
export function parseFromAddress(from: string): string | undefined {
  const angle = from.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (angle) return angle[1]!.toLowerCase();
  const bare = from.match(/[^<>@\s]+@[^<>@\s]+/);
  return bare ? bare[0].toLowerCase() : undefined;
}

export function shouldDropMessage(meta: EmailMetadata, selfEmail?: string, watchedSender?: string): boolean {
  // Compare the parsed sender address by EQUALITY, not substring: a substring
  // match false-drops humans whose address contains self's (self j@gmail.com
  // would drop aj@gmail.com). Self-drop is checked FIRST and is mandatory —
  // even an explicitly watched address never triggers on our own mail.
  const sender = parseFromAddress(meta.from ?? "");
  if (selfEmail && sender && sender === selfEmail.toLowerCase()) return true;
  // An explicitly watched sender bypasses the automated-sender heuristic: the
  // user asked for this exact address by name (e.g. noreply@ups.com), so the
  // heuristic must not silently swallow it. Exact address equality only.
  if (watchedSender && sender && sender === watchedSender.toLowerCase()) return false;
  const from = (meta.from ?? "").toLowerCase();
  if (AUTOMATED_FROM.test(from)) return true;
  return false;
}

// ── Item builders (RAW metadata; the runner fences) ──────────────────────────

// The raw matched-email metadata as a single JSON object, prefixed with a
// sender label so the shared thread's drafting turn can attribute each match to
// its sender (one thread carries matches across all watched senders). The hook
// runner is the prompt-injection boundary: it fences this untrusted text. The
// script emits the raw fields only.
export function buildMatchItem(meta: EmailMetadata): ResultItem {
  const from = meta.from ?? "(unknown)";
  const payload = JSON.stringify({
    from,
    subject: meta.subject ?? "(none)",
    date: meta.date ?? "(unknown)",
    id: meta.id,
    snippet: meta.snippet ?? ""
  });
  return { text: `New email from ${from} — ${payload}`, untrusted: true };
}

// The user's standing objective for a watch, as ONE TRUSTED item
// (untrusted:false — the runner renders it unfenced). The objective is
// validated config from the trusted tool/API channel, the same trust level as
// the job prompt; it must NEVER ride inside the untrusted fence, and untrusted
// email content never flows into it. Emitted only on ticks where the watch
// actually matched, so the drafting turn knows what its replies should achieve.
export function buildObjectiveItem(label: string, objective: string): ResultItem {
  return { text: `Objective for this watch (${label}): ${objective}`, untrusted: false };
}

// ── Self-email resolution (ported verbatim) ──────────────────────────────────

async function resolveSelfEmail(gwsSpawn: GwsSpawn): Promise<string | undefined> {
  try {
    const out = await gwsSpawn(buildProfileArgs());
    const doc = parseGwsJson(out);
    const email = doc?.emailAddress;
    return typeof email === "string" ? email : undefined;
  } catch {
    return undefined;
  }
}

// Fetch one message's internalDate (epoch ms), 0 when unavailable. Used to
// baseline the cursor from the newest listed message without enumerating the
// window.
async function fetchInternalDate(gwsSpawn: GwsSpawn, id: string): Promise<number> {
  const meta = parseMessageMetadata(await gwsSpawn(buildGetArgs(id)), id);
  const internalDate = meta.internalDate ? Number(meta.internalDate) : 0;
  return Number.isFinite(internalDate) && internalDate > 0 ? internalDate : 0;
}

// ── The engine (stateless) ───────────────────────────────────────────────────

// Run detection for ONE watch given its query + opaque state. Returns the typed
// result + the NEW state — pure: it makes the gws calls (the only side effect is
// the read-only subprocess) but never persists anything. The caller persists the
// returned state at the at-least-once commit boundary (a shortCircuit
// immediately; a context result only after the drafting turn dispatches).
//
// Three regimes, all governed by the fact that the `after:` watermark only ever
// moves FORWARD (to newer mail): you can never reach an older, un-listed tail by
// advancing it, so a path that needs the tail is wrong.
//
//  1. SEEDING (no cursor): BASELINE only. Take the newest listed id (Gmail lists
//     newest-first => window.ids[0]), fetch ITS internalDate, set the cursor
//     there, record that id plus any sibling sharing its exact epoch second
//     (Gmail's `after:` is inclusive of the boundary second) in `seen`, and emit
//     NO item. Pre-existing mail older than the baseline is excluded by `after:`
//     forever — the correct behavior (never draft a backlog), regardless of
//     inbox size.
//
//  2. STEADY-STATE, window NOT truncated: drain OLDEST-FIRST, cap the matches at
//     MAX_MESSAGES_PER_TICK, advance the cursor ONCE to the LAST CONSUMED item's
//     internalDate. A >cap backlog drains over successive ticks. The `seen` set
//     is recomputed to the ids sharing the new cursor's exact second so the
//     inclusive `after:` doesn't re-draft them next tick.
//
//  3. STEADY-STATE, window TRUNCATED (pageLimitHit: > the page cap of
//     genuinely-new matches, only reachable after downtime + high volume): the
//     older tail isn't listed, so oldest-first draining would silently skip it.
//     Don't draft the backlog and don't skip it silently — jump the cursor to
//     the NEWEST, record it in `seen`, and short-circuit with a non-silent
//     summary telling the user a backlog accumulated. The advanced state persists
//     immediately, so the notice fires at most once per episode.
export async function detect(
  args: DetectArgs,
  gwsSpawn: GwsSpawn,
  selfEmail: string | undefined
): Promise<DetectResult> {
  const stateIn: DetectState = args.state ?? {};
  const cursorIn = stateIn.cursor;
  const seenIn = new Set(stateIn.seen ?? []);
  const isSeeding = !cursorIn;

  // Bound the query with `after:<epochSec>` once a watermark exists (Gmail's
  // `after:` takes epoch seconds), so steady-state polling lists almost nothing.
  let query = args.query;
  if (!isSeeding) {
    const afterSec = Math.floor(Number(cursorIn) / 1000);
    if (Number.isFinite(afterSec) && afterSec > 0) {
      query = `${args.query} after:${afterSec}`;
    }
  }

  const window = parseMessageWindow(await gwsSpawn(buildListArgs(query)));

  // Regime 1: SEEDING — baseline the cursor at the newest match, draft nothing.
  if (isSeeding) {
    const newest = window.ids[0];
    const seen: string[] = [];
    let cursor: string;
    if (newest) {
      const internalDate = await fetchInternalDate(gwsSpawn, newest);
      cursor = String(internalDate > 0 ? internalDate : Date.now());
      seen.push(newest);
      // Gmail's `after:<sec>` is INCLUSIVE of the boundary second, so any other
      // pre-existing message sharing the newest's exact second is re-listed on
      // the first steady tick. Record each such sibling now (they're already on
      // this first listed page, newest-first) so they aren't drafted as "new".
      if (internalDate > 0) {
        const newestSec = Math.floor(internalDate / 1000);
        for (let i = 1; i < window.ids.length; i++) {
          const sib = window.ids[i]!;
          const sibDate = await fetchInternalDate(gwsSpawn, sib);
          if (sibDate <= 0 || Math.floor(sibDate / 1000) !== newestSec) break;
          seen.push(sib);
        }
      }
    } else {
      cursor = String(Date.now());
    }
    return { kind: "shortCircuit", summary: "[SILENT]", state: { cursor, seen, status: "ok" } };
  }

  // Regime 3: TRUNCATED steady-state window — the older tail isn't listed, so a
  // forward-only watermark can never reach it. Jump past the whole backlog to the
  // newest and short-circuit with a backlog notice. Bounded + non-silent.
  if (window.pageLimitHit) {
    const newest = window.ids[0];
    let cursor = cursorIn;
    if (newest) {
      const internalDate = await fetchInternalDate(gwsSpawn, newest);
      // Always advance the cursor (mirror seeding's fallback): a transient bad
      // metadata-get falls back to now() so the cursor can't get stuck.
      cursor = String(internalDate > 0 ? internalDate : Date.now());
    }
    const summary = [
      `A large backlog of emails matching this watch (query: ${args.query}) accumulated, likely while offline.`,
      "Not drafting replies to all of them. Ask me to triage this inbox if you want me to work through them."
    ].join(" ");
    return {
      kind: "shortCircuit",
      summary,
      state: { cursor, seen: newest ? [newest] : [], status: "ok" }
    };
  }

  // Regime 2: fully-enumerated steady-state window. Gmail returns newest-first;
  // drain oldest-first so a turn-cap never advances the cursor past an older,
  // un-consumed match.
  const ids = window.ids.slice().reverse();

  // The internalDate of the LAST item we consumed (collected an item for, or
  // dropped). The cursor advances to exactly this at the end.
  let lastConsumedInternalDate = Number(cursorIn) || 0;
  const items: ResultItem[] = [];
  let collected = 0;

  for (const id of ids) {
    // Already handled at the boundary second in a prior tick — skip. It's at the
    // current watermark, so it doesn't move lastConsumedInternalDate.
    if (seenIn.has(id)) continue;

    // Match cap reached: STOP consuming. Leave the remaining matches for the next
    // tick — the cursor will sit at the last consumed item, so `after:` re-lists.
    if (collected >= MAX_MESSAGES_PER_TICK) break;

    const meta = parseMessageMetadata(await gwsSpawn(buildGetArgs(id)), id);
    const internalDate = meta.internalDate ? Number(meta.internalDate) : 0;

    if (shouldDropMessage(meta, selfEmail, args.sender)) {
      // Safety floor dropped it — an intentional skip. Re-dropping it on a retry
      // is harmless (the floor is deterministic), so no separate dedup is needed.
      if (Number.isFinite(internalDate) && internalDate > lastConsumedInternalDate) {
        lastConsumedInternalDate = internalDate;
      }
      continue;
    }

    items.push(buildMatchItem(meta));
    collected += 1;
    if (Number.isFinite(internalDate) && internalDate > lastConsumedInternalDate) {
      lastConsumedInternalDate = internalDate;
    }
  }

  // A matched tick carries the watch's standing objective as ONE trusted item
  // alongside the untrusted matches (never on a no-match tick).
  if (collected > 0 && args.objective) {
    items.push(buildObjectiveItem(args.sender ?? args.query, args.objective));
  }

  const newCursor = lastConsumedInternalDate > 0 ? String(lastConsumedInternalDate) : cursorIn;

  // Recompute the boundary `seen` set: the ids sharing the new cursor's exact
  // epoch second (so the inclusive `after:` doesn't re-draft them next tick). We
  // already have their internalDates from the gets above for consumed items;
  // recompute from the listed window for correctness across the boundary.
  const seenOut = await boundarySeen(gwsSpawn, window.ids, newCursor, seenIn);

  if (items.length === 0) {
    // No delivery this tick (only dropped items, or nothing new): persist the
    // advanced cursor immediately (the caller treats shortCircuit as immediate).
    return { kind: "shortCircuit", summary: "[SILENT]", state: { cursor: newCursor, seen: seenOut, status: "ok" } };
  }

  // Surviving matches: the caller persists this state ONLY after the drafting
  // turn dispatches (the context => deferred timing), so a dispatch failure
  // leaves the old cursor and the matches re-trigger next tick (at-least-once).
  return { kind: "context", items, state: { cursor: newCursor, seen: seenOut, status: "ok" } };
}

// Compute the small boundary dedup set: the listed ids whose internalDate floors
// to the same epoch second as the new cursor, unioned with any prior-seen ids
// still at that second. Bounded to one second's worth of mail by the `after:`
// watermark.
async function boundarySeen(
  gwsSpawn: GwsSpawn,
  listedIds: string[],
  cursor: string | undefined,
  priorSeen: Set<string>
): Promise<string[]> {
  const cursorMs = Number(cursor) || 0;
  if (cursorMs <= 0) return [];
  const cursorSec = Math.floor(cursorMs / 1000);
  const out = new Set<string>();
  // Carry forward any prior-seen id (cheap; the set is already tiny) — it stays
  // relevant only while it's still at the boundary second, and a stale id is
  // harmless (it just won't be re-listed once the cursor moves past its second).
  for (const id of priorSeen) out.add(id);
  // Listed window is newest-first; the boundary-second ids are at the front.
  for (const id of listedIds) {
    const d = await fetchInternalDate(gwsSpawn, id);
    if (d <= 0) continue;
    const sec = Math.floor(d / 1000);
    if (sec > cursorSec) continue; // newer than the cursor — not yet at boundary
    if (sec < cursorSec) break; // older than the cursor — past the boundary
    out.add(id);
  }
  // Drop carried-forward ids that are now older than the cursor second so the set
  // can't grow unbounded across cursor advances.
  return [...out];
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function readStdinJson<T>(): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return (text ? JSON.parse(text) : {}) as T;
}

// Run one detection tick for ONE watch given its args + an injected gws spawn.
// Maps auth state + transport faults onto the health-in-state contract:
// signed-out => status:"needs_auth" with the prior cursor/seen UNCHANGED;
// gws/transport throw => status:"error" + a SCRUBBED lastError, cursor/seen
// UNCHANGED (the next healthy tick re-detects); a clean poll returns detect()'s
// status:"ok" result. Never throws — the backing job must stay alive and recover
// the moment gws is healthy/re-authed. An optional pre-resolved `selfEmail` lets
// the multi-watch loop resolve it once and share it across watches.
export async function run(
  args: DetectArgs,
  gwsSpawn: GwsSpawn,
  selfEmail?: string
): Promise<DetectResult> {
  const stateIn: DetectState = args.state ?? {};
  try {
    const status = parseGwsAuthStatus(await gwsSpawn(buildAuthStatusArgs()));
    if (!status.signedIn) {
      return { kind: "shortCircuit", summary: "[SILENT]", state: { ...stateIn, status: "needs_auth", lastError: undefined } };
    }
    const self = selfEmail ?? (await resolveSelfEmail(gwsSpawn));
    return await detect(args, gwsSpawn, self);
  } catch (error) {
    return {
      kind: "shortCircuit",
      summary: "[SILENT]",
      state: { ...stateIn, status: "error", lastError: scrubError(error instanceof Error ? error.message : String(error)) }
    };
  }
}

// Run one detection tick across ALL enabled watches of the shared email-watch job
// (one job + one thread for every watched sender). The gws session is a single
// signed-in identity, so the auth check + self-address resolution are done ONCE
// and shared; each watch then runs its own hardened single-watch regime against
// its own per-watch state in `byWatcher[watcherId]`.
//
//   - Signed out: every watch is marked needs_auth with its cursor/seen unchanged
//     (a session-level condition, shared across watches), 0 model turns.
//   - Per-watch: each watch is wrapped in its own try/catch so one sender's
//     gws/transport fault marks ONLY that watch's status:"error" (cursor/seen
//     unchanged) and the other watches still run and can still draft.
//   - Aggregation: all surviving matches across the watches become the items of a
//     single `context` result (the ONE drafting turn drafts a reply per match,
//     each labeled by sender). Per-watch backlog notices ride along: when at least
//     one watch matched they're appended as TRUSTED context items on the same
//     context result (so a backlog notice firing in the same tick as a sibling
//     match isn't dropped while its cursor advances); when nothing matched they're
//     joined into one non-silent shortCircuit summary instead.
//
// Commit timing is preserved by the consumer: a context result's state is
// persisted only after the drafting turn dispatches (at-least-once across the
// whole batch — a re-detect/re-drop on dispatch failure is idempotent); a
// shortCircuit's state persists immediately.
export async function runWatches(args: DetectArgsMulti, gwsSpawn: GwsSpawn): Promise<DetectResultMulti> {
  const watches = Array.isArray(args.watches) ? args.watches : [];
  const byWatcherIn = args.state?.byWatcher ?? {};
  const byWatcherOut: Record<string, DetectState> = {};
  const items: ResultItem[] = [];
  const notices: string[] = [];

  // Resolve auth + self ONCE for the shared gws session. A signed-out session is
  // shared by every watch, so short-circuit the whole tick marking each watch
  // needs_auth (cursor/seen unchanged).
  let signedIn: boolean;
  try {
    signedIn = parseGwsAuthStatus(await gwsSpawn(buildAuthStatusArgs())).signedIn;
  } catch (error) {
    // The auth probe itself faulted — a transport-level error shared across the
    // session. Mark every watch error with its cursor/seen unchanged.
    const scrubbed = scrubError(error instanceof Error ? error.message : String(error));
    for (const watch of watches) {
      byWatcherOut[watch.watcherId] = { ...(byWatcherIn[watch.watcherId] ?? {}), status: "error", lastError: scrubbed };
    }
    return { kind: "shortCircuit", summary: "[SILENT]", state: { byWatcher: byWatcherOut } };
  }
  if (!signedIn) {
    for (const watch of watches) {
      byWatcherOut[watch.watcherId] = { ...(byWatcherIn[watch.watcherId] ?? {}), status: "needs_auth", lastError: undefined };
    }
    return { kind: "shortCircuit", summary: "[SILENT]", state: { byWatcher: byWatcherOut } };
  }
  const selfEmail = await resolveSelfEmail(gwsSpawn);

  for (const watch of watches) {
    const stateIn = byWatcherIn[watch.watcherId] ?? {};
    // run() never throws (it maps gws faults onto status in state). The extra
    // try/catch is belt-and-suspenders so a bug in one watch can never abort the
    // others — that watch is marked error and the rest still run.
    let result: DetectResult;
    try {
      result = await run(
        { query: watch.query, account: watch.account, sender: watch.sender, objective: watch.objective, state: stateIn },
        gwsSpawn,
        selfEmail
      );
    } catch (error) {
      byWatcherOut[watch.watcherId] = {
        ...stateIn,
        status: "error",
        lastError: scrubError(error instanceof Error ? error.message : String(error))
      };
      continue;
    }
    byWatcherOut[watch.watcherId] = result.state;
    if (result.kind === "context" && result.items) {
      items.push(...result.items);
    } else if (result.summary && result.summary.trim() !== "[SILENT]" && result.summary.trim().length > 0) {
      // A non-silent shortCircuit summary (a per-watch backlog notice) — collect
      // it for the joined summary when no watch produced a draftable match.
      notices.push(result.summary);
    }
  }

  // Any matches across the watches => ONE drafting turn (context). Otherwise a
  // shortCircuit: a joined backlog notice if any fired, else silent.
  if (items.length > 0) {
    // A sibling watch can hit a truncated-window backlog in the SAME tick that
    // another watch produces a draftable match. The matching watch makes this a
    // context result (which commits every watch's advanced cursor on dispatch),
    // so the backlog notice would otherwise be dropped while its cursor still
    // advances — losing it for that episode. Carry each notice as a TRUSTED
    // context item (untrusted:false) so the single drafting turn surfaces the
    // backlog notice(s) alongside the drafts.
    const noticeItems: ResultItem[] = notices.map((text) => ({ text, untrusted: false }));
    return { kind: "context", items: [...items, ...noticeItems], state: { byWatcher: byWatcherOut } };
  }
  const summary = notices.length > 0 ? notices.join("\n\n") : "[SILENT]";
  return { kind: "shortCircuit", summary, state: { byWatcher: byWatcherOut } };
}

async function main(): Promise<void> {
  let args: DetectArgsMulti;
  try {
    args = await readStdinJson<DetectArgsMulti>();
  } catch (error) {
    // Bad stdin is reported as a shortCircuit with an empty byWatcher state, not a
    // non-zero exit, so the backing job stays alive. No prior state to preserve.
    process.stdout.write(JSON.stringify({
      kind: "shortCircuit",
      summary: "[SILENT]",
      state: { byWatcher: {} }
    } satisfies DetectResultMulti));
    return;
  }
  process.stdout.write(JSON.stringify(await runWatches(args, defaultGwsSpawn)));
}

// Parse the JSON `gws auth status` emits. signedIn := token_valid === true.
// Any parse failure / non-object output yields signedIn:false (a garbled CLI is
// treated as not-signed-in).
export function parseGwsAuthStatus(stdout: string): { signedIn: boolean } {
  const doc = parseGwsJson(stdout);
  return { signedIn: doc?.token_valid === true };
}

// Only run main when executed directly (the unit test imports the helpers).
if (import.meta.main) {
  await main();
}
