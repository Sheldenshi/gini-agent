#!/usr/bin/env bun
// analyze-call skill script.
//
// Contract:
//   stdin:  JSON { callId, goal?, questions }
//   env:    BLAND_API_KEY
//   stdout: JSON { ok, answers?, error? }
//   exit:   0 on success, 1 on hard failure (stdout still has the JSON)
//
// Ask Bland AI structured questions about a completed call
// (POST /v1/calls/<id>/analyze). Bland authenticates with a raw
// `authorization: <key>` header — no Bearer.
// Self-contained on purpose (no src/ imports): skill scripts must stay portable.

type Question = string | [string, string];

interface Args {
  callId: string;
  goal?: string;
  questions: Question[];
}

interface Result {
  ok: boolean;
  answers?: unknown[];
  error?: string;
}

const BLAND_CALLS_ENDPOINT = "https://api.bland.ai/v1/calls";
const TIMEOUT_MS = 30_000;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Build the POST /v1/calls/<id>/analyze request body. Bland expects
// `questions` as [question, answerType] pairs; bare-string entries default to
// answer type "string". `goal` is included only when non-empty.
export function buildAnalyzeBody(args: Pick<Args, "goal" | "questions">): Record<string, unknown> {
  const body: Record<string, unknown> = {
    questions: args.questions.map((entry) => (typeof entry === "string" ? [entry, "string"] : entry))
  };
  if (args.goal && args.goal.trim()) body.goal = args.goal;
  return body;
}

// A question entry is either a bare string or a [question, answerType] pair.
export function isQuestionEntry(entry: unknown): entry is Question {
  return typeof entry === "string" || (Array.isArray(entry) && typeof entry[0] === "string");
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
  if (!Array.isArray(args.questions) || args.questions.length === 0) {
    emit({ ok: false, error: "questions must be a non-empty array." }, 1);
  }
  if (!args.questions.every(isQuestionEntry)) {
    emit({ ok: false, error: "Each question must be a string or a [question, answerType] pair." }, 1);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BLAND_CALLS_ENDPOINT}/${encodeURIComponent(args.callId)}/analyze`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: apiKey
      },
      body: JSON.stringify(buildAnalyzeBody(args)),
      signal: controller.signal
    });
    const payload = (await response.json().catch(() => ({}))) as {
      status?: string;
      message?: string;
      answers?: unknown[];
    };
    if (!response.ok || payload.status !== "success") {
      emit({
        ok: false,
        error: payload.message ?? `Bland API returned HTTP ${response.status}`
      }, 1);
    }
    emit({ ok: true, answers: payload.answers ?? [] });
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
