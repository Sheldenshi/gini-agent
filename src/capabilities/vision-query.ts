// vision_query: ask the configured vision model a question about an
// existing Gini upload.
//
// Closes the loop where signed_download / promote_file / chat-attached
// images give the model an uploadId but the model couldn't trivially
// "see" what's in them — vision context is assembled at message-build
// time, not invoked on demand. This tool runs the vision model directly
// against an upload's bytes and returns the answer text, the same way
// browser_vision does against a fresh screenshot.

import type { RuntimeConfig } from "../types";
import { addAudit, appendTrace, mutateState, recordUsage } from "../state";
import { readUpload } from "../state/uploads";
import { generateVisionAnalysis } from "../provider";
import { resolveImageByteLimit } from "../provider-capabilities";

export interface VisionQueryParams {
  uploadId: string;
  question: string;
  maxTokens?: number;
}

export interface VisionQueryResult {
  ok: boolean;
  error?: string;
  answer?: string;
  usage?: Record<string, unknown>;
}

export interface InvokeVisionQueryOptions {
  taskId?: string;
}

export async function invokeVisionQuery(
  config: RuntimeConfig,
  params: VisionQueryParams,
  options: InvokeVisionQueryOptions = {}
): Promise<VisionQueryResult> {
  if (!params.uploadId) return { ok: false, error: "uploadId is required." };
  if (!params.question || !params.question.trim()) {
    return { ok: false, error: "question is required." };
  }

  const upload = readUpload(config.instance, params.uploadId);
  if (!upload) {
    return { ok: false, error: `Upload not found: ${params.uploadId}` };
  }
  // The provider measures the base64-encoded image payload against its cap, not
  // the decoded bytes. resolveImageByteLimit returns a raw-byte budget whose
  // base64 expansion (4/3) stays under that cap, so an accepted upload never
  // 400s at the provider. Larger images also blow the request budget and
  // produce useless answers.
  const maxBytes = resolveImageByteLimit(config.provider);
  if (upload.bytes.length > maxBytes) {
    return {
      ok: false,
      error: `Upload exceeds ${maxBytes} byte vision cap (got ${upload.bytes.length}).`
    };
  }
  // Vision providers accept png and jpeg reliably. Other image mimes
  // (webp/heic/svg) vary by provider; reject up front with a clear
  // suggestion to convert via terminal_exec before reaching the vision
  // path. Non-image uploads (PDF, log) aren't valid here at all.
  const mime = upload.mimeType;
  if (mime !== "image/png" && mime !== "image/jpeg") {
    return {
      ok: false,
      error: `vision_query only accepts image/png or image/jpeg uploads (got ${mime}). Convert via terminal_exec (e.g. \`sips -s format jpeg\`) and promote the result back to an upload before retrying.`
    };
  }

  appendTrace(config.instance, options.taskId ?? "", {
    type: "tool",
    message: `vision_query ${params.uploadId}`,
    data: { uploadId: params.uploadId, mimeType: mime, size: upload.bytes.length, question: params.question.slice(0, 200) }
  });

  let result;
  try {
    result = await generateVisionAnalysis(config, {
      prompt: params.question,
      imageBase64: Buffer.from(upload.bytes).toString("base64"),
      mimeType: mime,
      maxTokens: params.maxTokens
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitAudit(config, options.taskId, params, false, mime, upload.bytes.length, message);
    return { ok: false, error: `Vision provider failed: ${message}` };
  }

  await emitAudit(config, options.taskId, params, true, mime, upload.bytes.length, undefined);
  void recordUsage(config.instance, { source: "vision", taskId: options.taskId }, result.cost).catch(() => {});
  return { ok: true, answer: result.text, usage: result.usage };
}

async function emitAudit(
  config: RuntimeConfig,
  taskId: string | undefined,
  params: VisionQueryParams,
  ok: boolean,
  mimeType: string,
  size: number,
  errorSnippet: string | undefined
) {
  await mutateState(config.instance, (state) => {
    const ctx = taskId ? { taskId } : { system: true as const };
    addAudit(
      state,
      {
        actor: taskId ? "agent" : "runtime",
        action: "vision_query",
        target: params.uploadId,
        risk: "low",
        taskId,
        evidence: {
          uploadId: params.uploadId,
          mimeType,
          size,
          ok,
          questionBytes: params.question.length,
          error: errorSnippet ? errorSnippet.slice(0, 200) : undefined
        }
      },
      ctx
    );
  });
}
