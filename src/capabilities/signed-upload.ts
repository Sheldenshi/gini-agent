// signed_upload: PUT a Gini-stored upload's bytes to an arbitrary signed
// URL with caller-supplied headers.
//
// Motivating case: Linear (and GitHub, Notion, S3, …) attachment flows
// where the API returns a short-lived signed URL the client must PUT raw
// bytes to. The model can call `mcp_call` to get the URL + headers, and
// the matching MCP tool to finalize after — but the PUT in the middle has
// no general primitive today. `web_fetch` is GET-only, `mcp_call` only
// routes JSON-RPC, and the upload bytes live on disk where the model
// can't reach them. This tool is the bridge.
//
// Scope is intentionally narrow: the body is constrained to "bytes of a
// Gini upload the user attached to chat." The model picks the URL and
// headers; it cannot construct arbitrary payloads. That keeps the safety
// surface much smaller than a generic `http_put` would.

import type { RuntimeConfig } from "../types";
import { addAudit, appendTrace, mutateState } from "../state";
import { readUpload } from "../state/uploads";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface SignedUploadParams {
  uploadId: string;
  url: string;
  headers?: Record<string, string>;
}

export interface SignedUploadResult {
  ok: boolean;
  status?: number;
  error?: string;
  bytesSent?: number;
}

export interface InvokeSignedUploadOptions {
  taskId?: string;
  timeoutMs?: number;
  // Test hook — bypasses the real fetch. Production callers leave this
  // unset; tests pass a stub so they don't have to monkey-patch globals.
  putBytes?: (url: string, headers: Record<string, string>, bytes: Uint8Array) => Promise<{ ok: boolean; status: number; body?: string }>;
}

export async function invokeSignedUpload(
  config: RuntimeConfig,
  params: SignedUploadParams,
  options: InvokeSignedUploadOptions = {}
): Promise<SignedUploadResult> {
  if (!params.uploadId) return { ok: false, error: "uploadId is required." };
  if (!params.url) return { ok: false, error: "url is required." };
  if (!/^https:/i.test(params.url)) {
    return { ok: false, error: "signed_upload requires https URLs." };
  }

  const upload = readUpload(config.instance, params.uploadId);
  if (!upload) {
    return { ok: false, error: `Upload not found: ${params.uploadId}` };
  }

  const headers = sanitizeHeaders(params.headers);

  appendTrace(config.instance, options.taskId ?? "", {
    type: "tool",
    message: `signed_upload PUT ${hostOf(params.url)}`,
    data: {
      uploadId: params.uploadId,
      bytes: upload.bytes.length,
      mimeType: upload.mimeType,
      host: hostOf(params.url),
      headerKeys: Object.keys(headers)
    }
  });

  const putBytes = options.putBytes ?? defaultPutBytes(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let result: { ok: boolean; status: number; body?: string };
  try {
    result = await putBytes(params.url, headers, upload.bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitAudit(config, options.taskId, params, false, undefined, message);
    return { ok: false, error: `PUT failed: ${message}` };
  }

  await emitAudit(config, options.taskId, params, result.ok, result.status, result.ok ? undefined : result.body);
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: `PUT returned HTTP ${result.status}${result.body ? `: ${result.body.slice(0, 300)}` : ""}`
    };
  }
  return { ok: true, status: result.status, bytesSent: upload.bytes.length };
}

function defaultPutBytes(timeoutMs: number) {
  return async (url: string, headers: Record<string, string>, bytes: Uint8Array) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers,
        body: bytes as unknown as BodyInit,
        signal: controller.signal
      });
      if (!response.ok) {
        let body = "";
        try {
          body = (await response.text()).slice(0, 500);
        } catch {
          body = "";
        }
        return { ok: false, status: response.status, body };
      }
      return { ok: true, status: response.status };
    } finally {
      clearTimeout(timer);
    }
  };
}

function sanitizeHeaders(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof value !== "string") continue;
    out[key] = value;
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<unparseable-url>";
  }
}

async function emitAudit(
  config: RuntimeConfig,
  taskId: string | undefined,
  params: SignedUploadParams,
  ok: boolean,
  status: number | undefined,
  errorSnippet: string | undefined
) {
  await mutateState(config.instance, (state) => {
    const ctx = taskId ? { taskId } : { system: true as const };
    addAudit(
      state,
      {
        actor: taskId ? "agent" : "runtime",
        action: "signed_upload",
        target: hostOf(params.url),
        risk: "medium",
        taskId,
        evidence: {
          uploadId: params.uploadId,
          host: hostOf(params.url),
          ok,
          status: status ?? null,
          headerKeys: Object.keys(params.headers ?? {}),
          error: errorSnippet ? errorSnippet.slice(0, 200) : undefined
        }
      },
      ctx
    );
  });
}
