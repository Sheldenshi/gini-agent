#!/usr/bin/env bun
// call-watch hook script — Bland call-completion watcher, as a STATELESS,
// headless skill script for the generic `skill-script` pre-run hook
// (ADR job-pre-run-hooks.md). Not a `skill_run` script: it is the hook body
// for a background "call-watch" scheduled job, so an in-progress call costs
// zero model turns and the job's drafting turn fires exactly once, when the
// call finishes.
//
// Contract:
//   stdin:  JSON { callId, state: { done? } | null }
//   env:    BLAND_API_KEY
//   stdout: JSON { kind, items?, summary?, state }
//   exit:   0 on a clean tick; non-zero on a transport/HTTP fault — the
//           skill-script handler classes a non-zero exit as TRANSIENT, so the
//           backing job records the failure and retries next tick.
//
// Per tick:
//   - state.done        => silent shortCircuit, NO fetch. Backstop after
//                          delivery: the drafting turn is told to delete the
//                          job, and this keeps a leftover job quiet if a tick
//                          races that deletion.
//   - call in progress  => silent shortCircuit (zero model turns).
//   - call finished     => context with ONE untrusted item carrying the raw
//                          call result (status, answeredBy, callLengthMinutes,
//                          summary, transcript) + state { done: true }. The
//                          trusted hook runner fences the item.
//
// Pure: state rides in on stdin and out on the result; never touches files/DB.
// Self-contained on purpose (no src/ imports): skill scripts must stay portable.

interface CallWatchState {
  done?: boolean;
}

interface Args {
  callId?: string;
  state?: CallWatchState | null;
}

// A single injectable context item, matching the hook runner's HookContextItem.
interface ResultItem {
  text: string;
  untrusted: boolean;
}

// The hook output, as the skill-script handler maps it onto a HookResult.
interface CallWatchOutput {
  kind: "shortCircuit" | "context";
  items?: ResultItem[];
  summary?: string;
  state: CallWatchState;
}

const BLAND_CALLS_ENDPOINT = "https://api.bland.ai/v1/calls";
// Well under the skill-script hook's 20s child budget (SCRIPT_TIMEOUT_MS in
// src/capabilities/skill-script-hook.ts), so a stalled fetch surfaces as a
// clean timeout exit instead of the runner killing the process.
const TIMEOUT_MS = 15_000;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Whether the call has reached a terminal state. `completed` is Bland's
// finished flag; a failed call (never answered, rejected) can end with
// status "failed" / error_message instead, and must still wake the drafting
// turn — otherwise a dead call would poll silently forever.
export function isCallFinished(payload: Record<string, unknown>): boolean {
  if (payload.completed === true) return true;
  if (payload.status === "failed") return true;
  return typeof payload.error_message === "string" && payload.error_message.length > 0;
}

// The raw call result as ONE untrusted item (a label + JSON payload, mirroring
// gmail-watch's match items). The hook runner is the prompt-injection boundary:
// it fences this text; the script emits the raw fields only. The transcript
// rides LAST so the runner's char cap truncates it, never the summary. Note:
// Bland's `call_length` is in MINUTES, not seconds.
export function buildCallResultItem(payload: Record<string, unknown>): ResultItem {
  const details: Record<string, unknown> = {};
  if (typeof payload.call_id === "string") details.callId = payload.call_id;
  if (typeof payload.status === "string") details.status = payload.status;
  if (typeof payload.answered_by === "string") details.answeredBy = payload.answered_by;
  if (typeof payload.call_length === "number") details.callLengthMinutes = payload.call_length;
  if (typeof payload.error_message === "string") details.errorMessage = payload.error_message;
  if (typeof payload.summary === "string") details.summary = payload.summary;
  if (typeof payload.concatenated_transcript === "string") details.transcript = payload.concatenated_transcript;
  return { text: `Phone call finished — ${JSON.stringify(details)}`, untrusted: true };
}

// Decide the tick's hook output from the prior state and (when fetched) the
// Bland call payload. The done backstop takes no payload at all — main()
// checks it BEFORE fetching, so a delivered watch never re-hits the API.
export function evaluateCallWatch(
  state: CallWatchState | null | undefined,
  payload?: Record<string, unknown>
): CallWatchOutput {
  if (state?.done === true) {
    return { kind: "shortCircuit", summary: "[SILENT]", state: { done: true } };
  }
  if (!payload || !isCallFinished(payload)) {
    return { kind: "shortCircuit", summary: "[SILENT]", state: {} };
  }
  return { kind: "context", items: [buildCallResultItem(payload)], state: { done: true } };
}

// ── Imperative shell ─────────────────────────────────────────────────────────

async function readStdinJson<T>(): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("Skill script received no stdin payload.");
  return JSON.parse(text) as T;
}

function emit(result: CallWatchOutput): never {
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

// Transient-fault path: stderr + non-zero exit. The skill-script handler
// re-throws on a non-zero exit, the hook runner classes that transient, and
// the backing job stays active to retry next tick (the fault is visible on
// the job's lastError).
function fail(message: string): never {
  process.stderr.write(message);
  process.exit(1);
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = await readStdinJson<Args>();
  } catch (error) {
    fail(`Bad args: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Post-delivery backstop: no key, no fetch — just stay silent.
  if (args.state?.done === true) emit(evaluateCallWatch(args.state));

  const apiKey = process.env.BLAND_API_KEY;
  if (!apiKey) fail("Missing BLAND_API_KEY.");
  if (typeof args.callId !== "string" || args.callId.length === 0) fail("callId is required.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BLAND_CALLS_ENDPOINT}/${encodeURIComponent(args.callId)}`, {
      headers: {
        accept: "application/json",
        authorization: apiKey // Bland uses the raw key, no Bearer
      },
      signal: controller.signal
    });
    if (!response.ok) fail(`Bland API returned HTTP ${response.status}`);
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    emit(evaluateCallWatch(args.state, payload));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      fail(`Bland API request timed out after ${TIMEOUT_MS}ms`);
    }
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

// Only run main when executed directly (the unit test imports the pure helpers).
if (import.meta.main) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
