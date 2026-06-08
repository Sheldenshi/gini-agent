// Provider × model modality record — a living table of which providers/
// models accept image input (`vision`) and ingest documents natively
// (`nativeDocs`, e.g. PDF → text + page-images on the provider side).
//
// Used at task-build time to decide attachment delivery: `nativeDocs`
// gates the native `document` content part; `vision` is recorded for
// completeness but is NOT newly enforced (the image path stays unchanged).
//
// Defaults are conservative: an unknown provider/model resolves to
// { vision: false, nativeDocs: false } so we never emit a content part a
// provider can't parse.
//
// Update path: add a provider branch (or extend an existing one) below as
// providers/models gain modalities, with a source in the PR. The static
// per-provider/model-family table here is the v1 strategy; live discovery
// of OpenRouter's `architecture.input_modalities` (per routed model) is a
// follow-up that would replace the hardcoded OpenRouter family list.

import type { ProviderConfig } from "./types";

export interface ProviderModality {
  vision: boolean;
  nativeDocs: boolean;
}

// Known OpenAI vision/document model families. The `openai` provider name
// also covers custom OpenAI-compatible endpoints (a user-set baseUrl + an
// arbitrary model id), so gating on a known family keeps an unrecognized or
// text-only compatible model from being handed a `document` part it 400s on.
// The trailing boundary (end-of-string, `-`, or `.`) prevents prefix
// collisions: `gpt-5.4`/`gpt-4o-mini`/`o1-mini` match, but a colliding id
// like `gpt-5foo`/`gpt-4oish`/`o1derful` does not (defaults conservatively
// to false rather than being handed a document part).
const OPENAI_NATIVE_FAMILY = /^(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|chatgpt-4o)(?=$|[-.])/i;

// OpenRouter routes to many upstream models under `<vendor>/<model>` slugs.
// The families below are documented to accept image + file input via
// OpenRouter's unified `file` content part. Anything outside these families
// (or an unrecognized slug) falls back to the conservative default.
function openrouterModality(model: string): ProviderModality {
  const slug = model.toLowerCase();
  const supported =
    slug.startsWith("anthropic/") ||
    slug.startsWith("google/gemini") ||
    slug.startsWith("openai/");
  return supported ? { vision: true, nativeDocs: true } : { vision: false, nativeDocs: false };
}

export function resolveProviderModality(provider: ProviderConfig): ProviderModality {
  const model = provider.model ?? "";
  switch (provider.name) {
    case "openai":
      // gpt-4o / 4.1 / 5.x / o-series accept image input and ingest files
      // natively (Responses input_file / Chat-Completions file). Gate on a
      // known family so an unknown model id (or a custom OpenAI-compatible
      // endpoint pointed at a text-only model) stays conservatively false.
      return OPENAI_NATIVE_FAMILY.test(model)
        ? { vision: true, nativeDocs: true }
        : { vision: false, nativeDocs: false };
    case "openrouter":
      return openrouterModality(model);
    case "deepseek":
      // Confirmed text-only API — no image/file content part.
      return { vision: false, nativeDocs: false };
    case "anthropic":
      // Claude Opus/Sonnet/Haiku accept image input and ingest documents
      // natively via the Messages API (image + document content blocks). The
      // family is uniformly multimodal, so unlike the openai branch there's
      // no per-model gate. translateMessagesToAnthropic maps image_url and
      // document parts into the corresponding base64 source blocks.
      return { vision: true, nativeDocs: true };
    case "bedrock": {
      // Bedrock Converse exposes image content blocks per-model; enable vision
      // for the families that accept them (Claude 3+, the multimodal Nova tiers,
      // Mistral Pixtral, Llama 4, the Llama 3.2 vision variants). Text-only ids
      // (DeepSeek R1, Llama 3.3, Nova Micro) and unrecognized ids stay false so
      // the vision path never sends a block the model rejects.
      //
      // nativeDocs is false regardless: the Converse translator (converseUserContent)
      // does not emit `document` blocks, so document parts must flow through the
      // runtime's extract-to-text fallback rather than being passed "natively"
      // and silently dropped. (Native Converse document blocks are a follow-up.)
      const visionFamily =
        /anthropic\.claude|amazon\.nova-(?:pro|lite|premier)|pixtral|llama4|llama3-2-(?:11b|90b)/i.test(model);
      return { vision: visionFamily, nativeDocs: false };
    }
    case "codex":
      // Verified empirically against the live ChatGPT-backend /responses
      // surface (gpt-5.x): it accepts a native `input_file` document part
      // (a PDF sent as a document part — no inlined text — was read back
      // verbatim) and an `image_url`/`input_image` part (text in an image
      // was read back). The backend is undocumented but is a single known
      // surface serving gpt-5.x, so treat it as natively multimodal.
      return { vision: true, nativeDocs: true };
    case "local":
      // Text-only unless a vision-capable model is loaded; nativeDocs
      // essentially never. UNKNOWN → conservative false.
      // TODO: detect a loaded vision model and flip `vision` when present.
      return { vision: false, nativeDocs: false };
    case "echo":
      // Test stub; no real modality.
      return { vision: false, nativeDocs: false };
    default:
      // Unknown provider → conservative default.
      return { vision: false, nativeDocs: false };
  }
}
