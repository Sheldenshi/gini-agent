#!/usr/bin/env bun
// stop-call skill script.
//
// Contract:
//   stdin:  JSON { callId }
//   env:    BLAND_API_KEY
//   stdout: JSON { ok, message?, error? }
//   exit:   0 on success, 1 on hard failure (stdout still has the JSON)
//
// End an in-progress Bland AI call (POST /v1/calls/<id>/stop). Bland
// authenticates with a raw `authorization: <key>` header — no Bearer.
// Self-contained on purpose (no src/ imports): skill scripts must stay portable.

interface Args {
  callId: string;
}

interface Result {
  ok: boolean;
  message?: string;
  error?: string;
}

const BLAND_CALLS_ENDPOINT = "https://api.bland.ai/v1/calls";
const TIMEOUT_MS = 30_000;

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BLAND_CALLS_ENDPOINT}/${encodeURIComponent(args.callId)}/stop`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: apiKey
      },
      signal: controller.signal
    });
    const payload = (await response.json().catch(() => ({}))) as {
      status?: string;
      message?: string;
    };
    if (!response.ok || payload.status === "error") {
      emit({ ok: false, error: payload.message ?? `Bland API returned HTTP ${response.status}` }, 1);
    }
    emit({ ok: true, message: payload.message });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      emit({ ok: false, error: `Bland API request timed out after ${TIMEOUT_MS}ms` }, 1);
    }
    emit({ ok: false, error: error instanceof Error ? error.message : String(error) }, 1);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
