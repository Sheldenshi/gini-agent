// Provider × model capability record — a living table of which providers/
// models accept image input (`vision`), ingest documents natively
// (`nativeDocs`, e.g. PDF → text + page-images on the provider side), and
// how large their context windows are for prior-chat replay budgeting.
//
// Used at task-build time to decide attachment delivery and prior-history
// token budgets: `nativeDocs` gates the native `document` content part;
// `vision` is recorded for completeness but is NOT newly enforced (the image
// path stays unchanged).
//
// Defaults are conservative: an unknown provider/model resolves to
// { vision: false, nativeDocs: false } and a 32K-token context window so we
// never emit a content part a provider can't parse or assume a huge unknown
// context window.
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

export const PRIOR_CONTEXT_WINDOW_FRACTION = 0.65;
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 32_000;

// Known OpenAI vision/document model families. The `openai` provider name
// also covers custom OpenAI-compatible endpoints (a user-set baseUrl + an
// arbitrary model id), so gating on a known family keeps an unrecognized or
// text-only compatible model from being handed a `document` part it 400s on.
// The trailing boundary (end-of-string, `-`, or `.`) prevents prefix
// collisions: `gpt-5.4`/`gpt-4o-mini`/`o1-mini` match, but a colliding id
// like `gpt-5foo`/`gpt-4oish`/`o1derful` does not (defaults conservatively
// to false rather than being handed a document part).
const OPENAI_NATIVE_FAMILY = /^(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|chatgpt-4o)(?=$|[-.])/i;

function normalizeModel(model: string | undefined): string {
  return (model ?? "").trim().toLowerCase();
}

function openaiContextWindowTokens(model: string): number {
  const slug = normalizeModel(model);
  if (slug.length === 0) return FALLBACK_CONTEXT_WINDOW_TOKENS;
  if (/^gpt-5(?:\.[2345])?-chat(?=$|-)/.test(slug)) return 128_000;
  if (/^(gpt-4o|chatgpt-4o)(?=$|[-.])/.test(slug)) return 128_000;
  if (/^gpt-5\.5(?=$|[-.])/.test(slug)) return 1_000_000;
  if (/^gpt-5\.4-(mini|nano)(?=$|-)/.test(slug)) return 400_000;
  if (/^gpt-5\.4(?=$|-)/.test(slug)) return 1_050_000;
  if (/^gpt-5(?:\.[23])?(?=$|-)/.test(slug)) return 400_000;
  if (/^gpt-4\.1(?=$|-)/.test(slug)) return 1_047_576;
  if (/^o[134](?=$|-)/.test(slug)) return 200_000;
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

function deepseekContextWindowTokens(model: string): number {
  const slug = normalizeModel(model);
  if (/^deepseek-v4(?=$|-)/.test(slug)) return 1_000_000;
  if (slug === "deepseek-chat" || slug === "deepseek-reasoner") return 1_000_000;
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

function openrouterContextWindowTokens(model: string): number {
  const slug = normalizeModel(model);
  const slash = slug.indexOf("/");
  if (slash < 0) return FALLBACK_CONTEXT_WINDOW_TOKENS;
  const vendor = slug.slice(0, slash);
  const routedModel = slug.slice(slash + 1);
  if (vendor === "openai") return openaiContextWindowTokens(routedModel);
  if (vendor === "deepseek") return deepseekContextWindowTokens(routedModel);
  if (vendor === "anthropic") return 200_000;
  if (vendor === "google" && routedModel.startsWith("gemini")) return 1_000_000;
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

export function resolveProviderContextWindowTokens(provider: ProviderConfig): number {
  const model = provider.model ?? "";
  switch (provider.name) {
    case "openai":
    case "codex":
      return openaiContextWindowTokens(model);
    case "openrouter":
      return openrouterContextWindowTokens(model);
    case "deepseek":
      return deepseekContextWindowTokens(model);
    case "local":
    case "echo":
      return FALLBACK_CONTEXT_WINDOW_TOKENS;
    default:
      return FALLBACK_CONTEXT_WINDOW_TOKENS;
  }
}

export function resolveDefaultPriorContextTokenBudget(provider: ProviderConfig): number {
  return Math.floor(resolveProviderContextWindowTokens(provider) * PRIOR_CONTEXT_WINDOW_FRACTION);
}

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
