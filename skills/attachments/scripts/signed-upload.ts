#!/usr/bin/env bun
// signed-upload skill script.
//
// Contract:
//   stdin:  JSON { uploadId, url, headers? }
//   env:    GINI_UPLOADS_DIR
//   stdout: JSON { ok, status?, bytesSent?, error? }
//   exit:   0 on success, 1 on hard failure (stdout still has the JSON)
//
// PUT a Gini upload's bytes to a signed URL. The body is constrained to
// "bytes of a Gini upload" — the model picks the URL and the headers
// (typically copied verbatim from an API's prepare-step response).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface Args {
  uploadId: string;
  url: string;
  headers?: Record<string, string>;
}

interface Result {
  ok: boolean;
  status?: number;
  bytesSent?: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

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

function uploadPathFor(uploadsDir: string, uploadId: string): string | null {
  const manifestPath = join(uploadsDir, `${uploadId}.json`);
  if (!existsSync(manifestPath)) return null;
  const candidates = readdirSync(uploadsDir).filter(
    (name) => name.startsWith(`${uploadId}.`) && !name.endsWith(".json")
  );
  if (candidates.length === 0) return null;
  return join(uploadsDir, candidates[0]!);
}

async function main(): Promise<void> {
  const uploadsDir = process.env.GINI_UPLOADS_DIR;
  if (!uploadsDir) emit({ ok: false, error: "Missing GINI_UPLOADS_DIR." }, 1);

  let args: Args;
  try {
    args = await readStdinJson<Args>();
  } catch (error) {
    emit({ ok: false, error: `Bad args: ${error instanceof Error ? error.message : String(error)}` }, 1);
  }
  if (!args.uploadId) emit({ ok: false, error: "uploadId is required." }, 1);
  if (!args.url) emit({ ok: false, error: "url is required." }, 1);
  if (!/^https:/i.test(args.url)) emit({ ok: false, error: "signed-upload requires https URLs." }, 1);

  const path = uploadPathFor(uploadsDir, args.uploadId);
  if (!path) emit({ ok: false, error: `Upload not found: ${args.uploadId}` }, 1);

  const bytes = readFileSync(path);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.headers ?? {})) {
    if (typeof key === "string" && typeof value === "string") headers[key] = value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(args.url, {
      method: "PUT",
      headers,
      body: bytes,
      signal: controller.signal
    });
    if (!response.ok) {
      let body = "";
      try { body = (await response.text()).slice(0, 500); } catch { body = ""; }
      emit({
        ok: false,
        status: response.status,
        error: `PUT returned HTTP ${response.status}${body ? `: ${body}` : ""}`
      }, 1);
    }
    emit({ ok: true, status: response.status, bytesSent: bytes.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ ok: false, error: `PUT failed: ${message}` }, 1);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
