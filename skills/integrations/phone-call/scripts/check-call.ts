#!/usr/bin/env bun
// check-call skill script.
//
// Contract:
//   stdin:  JSON { callId, waitSeconds? }
//   env:    BLAND_API_KEY
//   stdout: JSON { ok, callId?, status?, completed?, answeredBy?,
//                  callLengthMinutes?, to?, from?, transcript?, summary?,
//                  recordingUrl?, errorMessage?, error? }
//   exit:   0 on success, 1 on hard failure (stdout still has the JSON)
//
// Fetch the status/result of a Bland AI call (GET /v1/calls/<id>). The
// transcript and summary are only populated once `completed` is true. Bland
// authenticates with a raw `authorization: <key>` header — no Bearer.
//
// `waitSeconds` (default 0, capped at 240 to stay inside the 5-minute script
// runner timeout) makes the script poll every 10s until the call completes or
// the budget runs out; either way the latest mapped details are emitted with
// ok:true, so the caller re-invokes with the same args until `completed`.
// Self-contained on purpose (no src/ imports): skill scripts must stay portable.

interface Args {
  callId: string;
  waitSeconds?: number;
}

interface Result {
  ok: boolean;
  callId?: string;
  status?: string;
  completed?: boolean;
  answeredBy?: string;
  callLengthMinutes?: number;
  to?: string;
  from?: string;
  transcript?: string;
  summary?: string;
  recordingUrl?: string;
  errorMessage?: string;
  error?: string;
}

const BLAND_CALLS_ENDPOINT = "https://api.bland.ai/v1/calls";
const TIMEOUT_MS = 30_000;
const MAX_WAIT_SECONDS = 240;
const POLL_INTERVAL_MS = 10_000;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Normalize the optional waitSeconds arg: default 0, clamp to [0, 240].
// Non-finite values fall back to 0 (single-shot).
export function normalizeWaitSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), MAX_WAIT_SECONDS);
}

// Map Bland's GET /v1/calls/<id> payload to the script result. Note: Bland's
// `call_length` is in MINUTES, not seconds.
export function mapCallDetails(payload: Record<string, unknown>): Result {
  const result: Result = { ok: true };
  if (typeof payload.call_id === "string") result.callId = payload.call_id;
  if (typeof payload.status === "string") result.status = payload.status;
  if (typeof payload.completed === "boolean") result.completed = payload.completed;
  if (typeof payload.answered_by === "string") result.answeredBy = payload.answered_by;
  if (typeof payload.call_length === "number") result.callLengthMinutes = payload.call_length;
  if (typeof payload.to === "string") result.to = payload.to;
  if (typeof payload.from === "string") result.from = payload.from;
  if (typeof payload.concatenated_transcript === "string") result.transcript = payload.concatenated_transcript;
  if (typeof payload.summary === "string") result.summary = payload.summary;
  if (typeof payload.recording_url === "string") result.recordingUrl = payload.recording_url;
  if (typeof payload.error_message === "string") result.errorMessage = payload.error_message;
  return result;
}

// ── Imperative shell ─────────────────────────────────────────────────────────

async function readStdinJson<T>(): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("Skill script received no stdin payload.");
  return JSON.parse(text) as T;
}

function emit(result: Result, exitCode = 0): never {
  process.stdout.write(JSON.stringify(result));
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const apiKey = process.env.BLAND_API_KEY;
  if (!apiKey) emit({ ok: false, error: "Missing BLAND_API_KEY." }, 1);

  let args: Args;
  try {
    args = await readStdinJson<Args>();
  } catch (error) {
    emit({ ok: false, error: `Bad args: ${error instanceof Error ? error.message : String(error)}` }, 1);
  }
  if (!args.callId) emit({ ok: false, error: "callId is required." }, 1);

  const deadline = Date.now() + normalizeWaitSeconds(args.waitSeconds) * 1000;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let result: Result;
    try {
      const response = await fetch(`${BLAND_CALLS_ENDPOINT}/${encodeURIComponent(args.callId)}`, {
        headers: {
          accept: "application/json",
          authorization: apiKey
        },
        signal: controller.signal
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        const message = typeof payload.message === "string" ? payload.message : undefined;
        emit({ ok: false, error: message ?? `Bland API returned HTTP ${response.status}` }, 1);
      }
      result = mapCallDetails(payload);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        emit({ ok: false, error: `Bland API request timed out after ${TIMEOUT_MS}ms` }, 1);
      }
      emit({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1);
    } finally {
      clearTimeout(timer);
    }
    const remainingMs = deadline - Date.now();
    if (result.completed === true || remainingMs <= 0) emit(result);
    await Bun.sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
  }
}

// Only run main when executed directly (the unit test imports the pure helpers).
if (import.meta.main) {
  main().catch((error) => {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}
