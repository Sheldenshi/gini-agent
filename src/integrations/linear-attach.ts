// Linear file-attachment orchestration.
//
// Linear's MCP exposes the upload flow as three steps the agent loop can't
// run on its own: `prepare_attachment_upload` returns a signed PUT URL +
// headers, the bytes have to be PUT to that URL inside a 60-second window,
// then `create_attachment_from_upload` finalizes the attachment row. The
// model can call MCP tools through `mcp_call`, but it can't read upload
// bytes off disk and it has no generic HTTP PUT. So this helper drives the
// full flow server-side: read upload → prepare → PUT → finalize.
//
// Auth + audit ride on top of `invokeMcpTool`, which logs every call
// through the existing `mcp.tool.invoked` audit + event channels.

import type { RuntimeConfig } from "../types";
import { readState } from "../state";
import { readUpload } from "../state/uploads";
import { invokeMcpTool } from "./mcp";

export interface LinearAttachParams {
  issue: string;
  uploadId: string;
  title?: string;
  subtitle?: string;
}

export interface LinearAttachResult {
  ok: boolean;
  error?: string;
  assetUrl?: string;
  attachment?: Record<string, unknown>;
}

// PUT bytes upload step is split out so tests can stub the network without
// stubbing every fetch in the process.
export type LinearPutBytes = (
  url: string,
  headers: Record<string, string>,
  bytes: Uint8Array
) => Promise<{ ok: boolean; status?: number; body?: string }>;

const defaultPutBytes: LinearPutBytes = async (url, headers, bytes) => {
  const response = await fetch(url, {
    method: "PUT",
    headers,
    // Bun's fetch accepts Uint8Array as a body without needing a copy.
    body: bytes as unknown as BodyInit
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
};

export async function attachImageToLinearIssue(
  config: RuntimeConfig,
  taskId: string,
  params: LinearAttachParams,
  putBytes: LinearPutBytes = defaultPutBytes
): Promise<LinearAttachResult> {
  const upload = readUpload(config.instance, params.uploadId);
  if (!upload) {
    return { ok: false, error: `Upload not found: ${params.uploadId}` };
  }

  const state = readState(config.instance);
  const server = state.mcpServers.find(
    (item) => item.name.toLowerCase() === "linear" && item.status === "configured"
  );
  if (!server) {
    return { ok: false, error: "Linear MCP server is not configured. Use request_connector to connect Linear first." };
  }

  const filename = uploadFilename(upload.filename, upload.mimeType, params.title);

  const prepared = await invokeMcpTool(
    config,
    server.id,
    "prepare_attachment_upload",
    {
      issue: params.issue,
      filename,
      contentType: upload.mimeType,
      size: upload.bytes.length,
      ...(params.title ? { title: params.title } : {}),
      ...(params.subtitle ? { subtitle: params.subtitle } : {})
    },
    { taskId }
  );
  if (!prepared.ok) {
    return { ok: false, error: `prepare_attachment_upload failed: ${prepared.message ?? "unknown error"}` };
  }
  const preparedPayload = parseMcpJsonPayload(prepared.stdout);
  if (!preparedPayload) {
    return { ok: false, error: `prepare_attachment_upload returned an unparseable payload.` };
  }
  const uploadRequest = preparedPayload.uploadRequest as { url?: string; headers?: Record<string, string> } | undefined;
  const assetUrl = typeof preparedPayload.assetUrl === "string" ? preparedPayload.assetUrl : undefined;
  if (!uploadRequest?.url || !uploadRequest.headers || !assetUrl) {
    return { ok: false, error: "prepare_attachment_upload response is missing uploadRequest.url / headers / assetUrl." };
  }

  const put = await putBytes(uploadRequest.url, uploadRequest.headers, upload.bytes);
  if (!put.ok) {
    return {
      ok: false,
      error: `Direct file upload to Linear failed: HTTP ${put.status ?? "?"}${put.body ? ` — ${put.body}` : ""}`
    };
  }

  const finalized = await invokeMcpTool(
    config,
    server.id,
    "create_attachment_from_upload",
    {
      issue: params.issue,
      assetUrl,
      ...(params.title ? { title: params.title } : {}),
      ...(params.subtitle ? { subtitle: params.subtitle } : {})
    },
    { taskId }
  );
  if (!finalized.ok) {
    // The bytes are uploaded but the attachment row didn't land. Surface the
    // assetUrl so the user / caller can retry the finalize step or paste the
    // url into the issue manually.
    return {
      ok: false,
      assetUrl,
      error: `create_attachment_from_upload failed: ${finalized.message ?? "unknown error"}`
    };
  }
  const finalizedPayload = parseMcpJsonPayload(finalized.stdout);
  return {
    ok: true,
    assetUrl,
    attachment: finalizedPayload ?? undefined
  };
}

function parseMcpJsonPayload(stdout: string | undefined): Record<string, unknown> | null {
  if (!stdout) return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function uploadFilename(stored: string | undefined, mimeType: string, title?: string): string {
  if (stored && stored.length > 0) return stored;
  const ext = extensionFor(mimeType);
  const base = title?.trim().length ? title.trim().replace(/[\\/]/g, "-").slice(0, 80) : "screenshot";
  return ext ? `${base}.${ext}` : base;
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
    default: {
      const slash = mimeType.indexOf("/");
      return slash >= 0 ? mimeType.slice(slash + 1).replace(/[^a-z0-9]/gi, "") : "";
    }
  }
}
