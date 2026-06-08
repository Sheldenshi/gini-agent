#!/usr/bin/env bun
// gmail-watch detection engine — the deterministic email-watch detection floor,
// as a STATELESS, headless skill script (ADR email-watch.md).
//
// Provisioned + trusted: this script is shipped in-tree and run by the generic
// `skill-script` hook handler with no agent turn and no approval. It is the hook
// BODY for an email watcher's backing scheduled job.
//
// Contract:
//   stdin:  JSON { query, account?, state: { cursor?, seen? } | null }
//   stdout: JSON { kind, items?, summary?, note?, state }
//   exit:   0 always (a gws/transport error is reported as a shortCircuit with a
//           note, never a non-zero exit, so the backing job stays alive)
//
// It polls `gws` for new matching message ids for ONE watch, dedups against the
// caller-supplied state (cursor + a tiny boundary `seen` set), applies a
// deterministic safety floor (drop automated senders + self), and emits the raw
// metadata (From/Subject/Date/snippet) of each surviving NEW match as an
// untrusted item — it reads ONLY metadata, never message bodies, and emits NO
// fence (the trusted hook runner fences untrusted items). The script is a PURE
// function of {query, state}: it never touches files or a DB; the new cursor +
// seen set ride back on the result and the caller persists them.

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
}

interface DetectArgs {
  query: string;
  account?: string;
  state?: DetectState | null;
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
  // Status note the handler/runtime can map to the watcher status (e.g.
  // "needs_auth", "error"). Never fails the job — a transport problem is a
  // shortCircuit with a note, not a non-zero exit.
  note?: "needs_auth" | "error";
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

export function shouldDropMessage(meta: EmailMetadata, selfEmail?: string): boolean {
  const from = (meta.from ?? "").toLowerCase();
  if (AUTOMATED_FROM.test(from)) return true;
  // Compare the parsed sender address by EQUALITY, not substring: a substring
  // match false-drops humans whose address contains self's (self j@gmail.com
  // would drop aj@gmail.com).
  if (selfEmail) {
    const sender = parseFromAddress(meta.from ?? "");
    if (sender && sender === selfEmail.toLowerCase()) return true;
  }
  return false;
}

// ── Item builders (RAW metadata; the runner fences) ──────────────────────────

// The raw matched-email metadata as a single JSON object. The hook runner is the
// prompt-injection boundary: it fences this untrusted text. The script emits the
// raw fields only.
export function buildMatchItem(meta: EmailMetadata): ResultItem {
  const text = JSON.stringify({
    from: meta.from ?? "(unknown)",
    subject: meta.subject ?? "(none)",
    date: meta.date ?? "(unknown)",
    id: meta.id,
    snippet: meta.snippet ?? ""
  });
  return { text, untrusted: true };
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
// returned state at the J4-correct moment.
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
    return { kind: "shortCircuit", summary: "[SILENT]", state: { cursor, seen } };
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
      state: { cursor, seen: newest ? [newest] : [] }
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

    if (shouldDropMessage(meta, selfEmail)) {
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

  const newCursor = lastConsumedInternalDate > 0 ? String(lastConsumedInternalDate) : cursorIn;

  // Recompute the boundary `seen` set: the ids sharing the new cursor's exact
  // epoch second (so the inclusive `after:` doesn't re-draft them next tick). We
  // already have their internalDates from the gets above for consumed items;
  // recompute from the listed window for correctness across the boundary.
  const seenOut = await boundarySeen(gwsSpawn, window.ids, newCursor, seenIn);

  if (items.length === 0) {
    // No delivery this tick (only dropped items, or nothing new): persist the
    // advanced cursor immediately (the caller treats shortCircuit as immediate).
    return { kind: "shortCircuit", summary: "[SILENT]", state: { cursor: newCursor, seen: seenOut } };
  }

  // Surviving matches: the caller persists this state ONLY after the drafting
  // turn dispatches (the context => deferred timing), so a dispatch failure
  // leaves the old cursor and the matches re-trigger next tick (at-least-once).
  return { kind: "context", items, state: { cursor: newCursor, seen: seenOut } };
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

async function main(): Promise<void> {
  let args: DetectArgs;
  try {
    args = await readStdinJson<DetectArgs>();
  } catch (error) {
    // Bad stdin is reported as a shortCircuit error note, not a non-zero exit, so
    // the backing job stays alive.
    process.stdout.write(JSON.stringify({
      kind: "shortCircuit",
      summary: "[SILENT]",
      note: "error",
      state: {}
    }));
    return;
  }

  const stateIn: DetectState = args.state ?? {};
  const gwsSpawn = defaultGwsSpawn;

  // Signed-out handling: a missing/expired gws session is reported as a
  // shortCircuit with a needs_auth note (the handler/runtime maps it onto the
  // watcher status), NEVER a non-zero exit — the backing job must keep polling so
  // it recovers the moment the user re-auths.
  try {
    const status = parseGwsAuthStatus(await gwsSpawn(buildAuthStatusArgs()));
    if (!status.signedIn) {
      process.stdout.write(JSON.stringify({
        kind: "shortCircuit",
        summary: "[SILENT]",
        note: "needs_auth",
        state: stateIn
      }));
      return;
    }

    const selfEmail = await resolveSelfEmail(gwsSpawn);
    const result = await detect(args, gwsSpawn, selfEmail);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    // Any gws/transport error: report a shortCircuit with an error note + the
    // UNCHANGED state (so the next healthy tick re-detects), never a non-zero
    // exit. A scrubbed message rides in `summary` for observability.
    process.stdout.write(JSON.stringify({
      kind: "shortCircuit",
      summary: "[SILENT]",
      note: "error",
      state: stateIn
    }));
  }
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
