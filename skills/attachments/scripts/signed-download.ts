#!/usr/bin/env bun
// signed-download skill script.
//
// Contract:
//   stdin:  JSON { url, headers?, filename? }
//   env:    GINI_UPLOADS_DIR
//   stdout: JSON { ok, uploadId?, mimeType?, size?, error? }
//   exit:   0 on success, 1 on hard failure
//
// GET bytes from a URL and store them as a Gini upload. Lets the model
// route external content (provider attachment URLs, raw file URLs,
// user-pasted URLs) into Gini's upload-addressable space.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

interface Args {
  url: string;
  headers?: Record<string, string>;
  filename?: string;
}

interface Result {
  ok: boolean;
  uploadId?: string;
  mimeType?: string;
  size?: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BYTES = 50 * 1024 * 1024;

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

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/heic": return "heic";
    case "image/heif": return "heif";
    case "image/svg+xml": return "svg";
    case "application/pdf": return "pdf";
    case "application/json": return "json";
    case "text/plain": return "txt";
    case "text/markdown": return "md";
    case "text/csv": return "csv";
    case "text/html": return "html";
    case "application/xml": return "xml";
    case "application/zip": return "zip";
    default: {
      const slash = mimeType.indexOf("/");
      return slash >= 0 ? mimeType.slice(slash + 1).replace(/[^a-z0-9]/gi, "") || "bin" : "bin";
    }
  }
}

function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return last || "download";
  } catch {
    return "download";
  }
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
  if (!args.url) emit({ ok: false, error: "url is required." }, 1);
  if (!/^https:/i.test(args.url)) emit({ ok: false, error: "signed-download requires https URLs." }, 1);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.headers ?? {})) {
    if (typeof key === "string" && typeof value === "string") headers[key] = value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let bytes: Uint8Array;
  let mimeType = "application/octet-stream";
  try {
    const response = await fetch(args.url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) {
      let body = "";
      try { body = (await response.text()).slice(0, 500); } catch { body = ""; }
      emit({
        ok: false,
        error: `GET returned HTTP ${response.status}${body ? `: ${body}` : ""}`
      }, 1);
    }
    const buf = await response.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      emit({ ok: false, error: `Response exceeded ${MAX_BYTES} byte cap (got ${buf.byteLength}).` }, 1);
    }
    if (buf.byteLength === 0) {
      emit({ ok: false, error: "GET succeeded but returned no bytes." }, 1);
    }
    bytes = new Uint8Array(buf);
    const ct = response.headers.get("content-type");
    if (ct) {
      const stripped = ct.split(";")[0]!.trim();
      if (stripped) mimeType = stripped;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ ok: false, error: `GET failed: ${message}` }, 1);
  } finally {
    clearTimeout(timer);
  }

  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  const id = randomUUID();
  const ext = extensionFor(mimeType);
  const filename = args.filename ?? basenameFromUrl(args.url);
  writeFileSync(join(uploadsDir, `${id}.${ext}`), bytes);
  const manifest = {
    id,
    mimeType,
    filename,
    size: bytes.length,
    createdAt: new Date().toISOString()
  };
  writeFileSync(join(uploadsDir, `${id}.json`), JSON.stringify(manifest));

  emit({ ok: true, uploadId: id, mimeType, size: bytes.length });
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
