#!/usr/bin/env bun
// place-call skill script.
//
// Contract:
//   stdin:  JSON { phoneNumber, task, voice?, firstSentence?, waitForGreeting?,
//                  record?, maxDurationMinutes?, language? }
//   env:    BLAND_API_KEY
//   stdout: JSON { ok, callId?, error? }
//   exit:   0 on success, 1 on hard failure (stdout still has the JSON)
//
// Start an outbound AI phone call via Bland AI (POST /v1/calls). Bland
// authenticates with a raw `authorization: <key>` header — no Bearer.
// Self-contained on purpose (no src/ imports): skill scripts must stay portable.

interface Args {
  phoneNumber: string;
  task: string;
  voice?: string;
  firstSentence?: string;
  waitForGreeting?: boolean;
  record?: boolean;
  maxDurationMinutes?: number;
  language?: string;
}

interface Result {
  ok: boolean;
  callId?: string;
  error?: string;
}

const BLAND_CALLS_ENDPOINT = "https://api.bland.ai/v1/calls";
const TIMEOUT_MS = 30_000;

// E.164: leading +, country code 1-9, up to 15 digits total.
export const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Build the POST /v1/calls request body. Defaults: wait for the callee's
// greeting before speaking, no recording (consent laws vary), 10-minute cap.
// Optional fields the caller didn't supply are omitted entirely.
export function buildCallBody(args: Args): Record<string, unknown> {
  const body: Record<string, unknown> = {
    phone_number: args.phoneNumber,
    task: args.task,
    wait_for_greeting: args.waitForGreeting ?? true,
    record: args.record ?? false,
    max_duration: args.maxDurationMinutes ?? 10
  };
  if (args.voice) body.voice = args.voice;
  if (args.firstSentence) body.first_sentence = args.firstSentence;
  if (args.language) body.language = args.language;
  return body;
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
  if (!args.phoneNumber || !E164_PATTERN.test(args.phoneNumber)) {
    emit({ ok: false, error: "phoneNumber must be E.164 (e.g. +15551234567)." }, 1);
  }
  if (!args.task || !args.task.trim()) emit({ ok: false, error: "task is required." }, 1);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(BLAND_CALLS_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: apiKey
      },
      body: JSON.stringify(buildCallBody(args)),
      signal: controller.signal
    });
    const payload = (await response.json().catch(() => ({}))) as {
      status?: string;
      message?: string;
      call_id?: string;
    };
    if (!response.ok || payload.status !== "success" || !payload.call_id) {
      emit({
        ok: false,
        error: payload.message ?? `Bland API returned HTTP ${response.status}`
      }, 1);
    }
    emit({ ok: true, callId: payload.call_id });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      emit({ ok: false, error: `Bland API request timed out after ${TIMEOUT_MS}ms` }, 1);
    }
    emit({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1);
  } finally {
    clearTimeout(timer);
  }
}

// Only run main when executed directly (the unit test imports the pure helpers).
if (import.meta.main) {
  main().catch((error) => {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}
