#!/usr/bin/env bun
// Skill-script: attach a chat-uploaded image to a Linear issue.
//
// Contract (Gini skill-script invocation):
//   - stdin:  JSON { issue, uploadId, title?, subtitle? }
//   - env:    LINEAR_API_KEY (resolved from the Linear connector)
//             GINI_UPLOADS_DIR (absolute path to ~/.gini/instances/<i>/uploads)
//   - stdout: JSON { ok, error?, assetUrl?, attachment? }
//   - exit:   0 on success, 1 on hard failure (stdout still carries the JSON)
//
// Hits Linear's GraphQL API directly (no MCP detour). The orchestration
// runs server-side because the model has no general HTTP PUT primitive —
// the prepare → PUT → finalize sequence has to live somewhere with
// runtime privileges, and "somewhere" is this script.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface Args {
  issue: string;
  uploadId: string;
  title?: string;
  subtitle?: string;
}

interface FileUploadPayload {
  fileUpload: {
    success: boolean;
    uploadFile: {
      uploadUrl: string;
      assetUrl: string;
      headers: Array<{ key: string; value: string }>;
    };
  };
}

interface AttachmentCreatePayload {
  attachmentCreate: {
    success: boolean;
    attachment?: {
      id: string;
      title: string;
      url: string;
      subtitle?: string | null;
    };
  };
}

interface Result {
  ok: boolean;
  error?: string;
  assetUrl?: string;
  attachment?: AttachmentCreatePayload["attachmentCreate"]["attachment"];
}

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

async function readStdinJson<T>(): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("Skill script received no stdin payload.");
  return JSON.parse(text) as T;
}

function emit(result: Result, exitCode = 0): never {
  process.stdout.write(JSON.stringify(result));
  process.exit(exitCode);
}

function uploadPathFor(uploadsDir: string, uploadId: string): { path: string; mimeType: string; size: number } | null {
  // Manifest lives next to the bytes as <id>.json; the blob extension is
  // derived from manifest.mimeType.
  const manifestPath = join(uploadsDir, `${uploadId}.json`);
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { mimeType: string; size: number };
  // Try the typical extensions for the manifest's mime; we don't need to
  // duplicate the whole mime→ext table here. Scan the directory for a file
  // matching the upload id as a fallback.
  const candidates = readdirSync(uploadsDir).filter((name) => name.startsWith(`${uploadId}.`) && !name.endsWith(".json"));
  if (candidates.length === 0) return null;
  return { path: join(uploadsDir, candidates[0]!), mimeType: manifest.mimeType, size: manifest.size };
}

async function linearGraphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: token
    },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Linear GraphQL HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const payload = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(payload.errors.map((e) => e.message ?? "unknown").join("; "));
  }
  if (!payload.data) throw new Error("Linear GraphQL returned no data.");
  return payload.data;
}

async function resolveIssueId(token: string, issue: string): Promise<string> {
  // Issue identifiers like "ENG-1234" need to be resolved to a UUID for
  // attachmentCreate. A UUID-shaped input is passed through. Linear's
  // `issue` query accepts either form so the same call covers both.
  const data = await linearGraphql<{ issue: { id: string } | null }>(
    token,
    "query($id: String!) { issue(id: $id) { id } }",
    { id: issue }
  );
  if (!data.issue) throw new Error(`Linear issue not found: ${issue}`);
  return data.issue.id;
}

async function main(): Promise<void> {
  const token = process.env.LINEAR_API_KEY;
  const uploadsDir = process.env.GINI_UPLOADS_DIR;
  if (!token) emit({ ok: false, error: "Missing LINEAR_API_KEY. Connect the Linear connector first." }, 1);
  if (!uploadsDir) emit({ ok: false, error: "Missing GINI_UPLOADS_DIR." }, 1);

  let args: Args;
  try {
    args = await readStdinJson<Args>();
  } catch (error) {
    emit({ ok: false, error: `Bad args: ${error instanceof Error ? error.message : String(error)}` }, 1);
  }
  if (!args.issue || !args.uploadId) {
    emit({ ok: false, error: "Required fields: issue, uploadId." }, 1);
  }

  const upload = uploadPathFor(uploadsDir, args.uploadId);
  if (!upload) emit({ ok: false, error: `Upload not found: ${args.uploadId}` }, 1);

  const filename = (args.title?.trim() || "screenshot") + extensionFor(upload.mimeType);

  // Step 1: prepare. Linear's `fileUpload` mutation returns an upload URL,
  // an asset URL, and the headers the client must send verbatim on the
  // PUT. Signed URLs expire in ~60 seconds — we PUT immediately.
  let prepared: FileUploadPayload;
  try {
    prepared = await linearGraphql<FileUploadPayload>(
      token,
      "mutation($contentType: String!, $filename: String!, $size: Int!) {\n  fileUpload(contentType: $contentType, filename: $filename, size: $size) {\n    success\n    uploadFile {\n      uploadUrl\n      assetUrl\n      headers { key value }\n    }\n  }\n}",
      { contentType: upload.mimeType, filename, size: upload.size }
    );
  } catch (error) {
    emit({ ok: false, error: `fileUpload prepare failed: ${error instanceof Error ? error.message : String(error)}` }, 1);
  }
  const uploadFile = prepared.fileUpload?.uploadFile;
  const uploadUrl = uploadFile?.uploadUrl;
  const assetUrl = uploadFile?.assetUrl;
  const headerList = uploadFile?.headers ?? [];
  if (!uploadUrl || !assetUrl) emit({ ok: false, error: "fileUpload response missing uploadUrl / assetUrl." }, 1);

  // Step 2: PUT the bytes to the signed URL with the headers Linear gave
  // us verbatim. The signed-headers list on the URL is
  // `content-type;host;x-goog-content-length-range` — `host` is set by
  // fetch automatically, but `content-type` is NOT in Linear's response
  // headers array (their MCP variant adds it for convenience; the raw
  // GraphQL leaves it to the caller). We set it explicitly to the same
  // value we passed to fileUpload's contentType arg, otherwise GCS
  // rejects with `MalformedSecurityHeader: content-type was included
  // in signedheaders but not in the request`.
  const headers: Record<string, string> = { "content-type": upload.mimeType };
  for (const h of headerList) headers[h.key] = h.value;
  const bytes = readFileSync(upload.path);
  const putResp = await fetch(uploadUrl, { method: "PUT", headers, body: bytes });
  if (!putResp.ok) {
    const body = await putResp.text().catch(() => "");
    emit({ ok: false, assetUrl, error: `Direct file upload failed: HTTP ${putResp.status} ${body.slice(0, 300)}` }, 1);
  }

  // Step 3: create the attachment row pointing at the asset URL. We
  // resolve the issue identifier (e.g. "ENG-1234") to a UUID via the issue
  // query because attachmentCreate's `issueId` is strictly a UUID.
  let issueUuid: string;
  try {
    issueUuid = await resolveIssueId(token, args.issue);
  } catch (error) {
    emit({ ok: false, assetUrl, error: `Could not resolve issue ${args.issue}: ${error instanceof Error ? error.message : String(error)}` }, 1);
  }
  let finalized: AttachmentCreatePayload;
  try {
    finalized = await linearGraphql<AttachmentCreatePayload>(
      token,
      "mutation($input: AttachmentCreateInput!) {\n  attachmentCreate(input: $input) {\n    success\n    attachment { id title url subtitle }\n  }\n}",
      {
        input: {
          issueId: issueUuid,
          url: assetUrl,
          title: args.title ?? filename,
          ...(args.subtitle ? { subtitle: args.subtitle } : {})
        }
      }
    );
  } catch (error) {
    emit({ ok: false, assetUrl, error: `attachmentCreate failed: ${error instanceof Error ? error.message : String(error)}` }, 1);
  }
  if (!finalized.attachmentCreate?.success) {
    emit({ ok: false, assetUrl, error: "attachmentCreate returned success=false." }, 1);
  }
  emit({ ok: true, assetUrl, attachment: finalized.attachmentCreate.attachment });
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return ".png";
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "image/heic": return ".heic";
    case "image/heif": return ".heif";
    case "image/svg+xml": return ".svg";
    default: return "";
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
