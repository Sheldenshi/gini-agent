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

// The ChatGPT Codex backend enforces a ~275k effective context window
// regardless of the underlying model's nominal window: gpt-5.5 is 1M on the
// direct OpenAI API but only 275k when served through Codex. Cap the codex
// provider at this backend limit so prior-context packing budgets against the
// real window instead of the model's larger nominal one.
export const CODEX_BACKEND_CONTEXT_WINDOW_TOKENS = 275_000;

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

// First-party Anthropic Messages API: the Claude family serves a 200K-token
// context window. An unrecognized id stays conservative on the fallback.
function anthropicContextWindowTokens(model: string): number {
  if (/claude/.test(normalizeModel(model))) return 200_000;
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

// Bedrock model ids are cross-region inference profiles, e.g.
// "us.anthropic.claude-opus-4-8" or "us.amazon.nova-pro-v1:0". Key off the
// provider+family segment so each family gets its real window; unknown ids
// (other Bedrock families we don't enumerate) keep the conservative fallback.
function bedrockContextWindowTokens(model: string): number {
  const slug = normalizeModel(model);
  if (/anthropic\.claude/.test(slug)) return 200_000;
  if (/amazon\.nova-premier/.test(slug)) return 1_000_000;
  if (/amazon\.nova-(pro|lite)/.test(slug)) return 300_000;
  if (/amazon\.nova-micro/.test(slug)) return 128_000;
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

export function resolveProviderContextWindowTokens(provider: ProviderConfig): number {
  const model = provider.model ?? "";
  switch (provider.name) {
    case "openai":
    // Azure hosts the same OpenAI models, so the context window follows the
    // model family just like standard OpenAI.
    case "azure":
      return openaiContextWindowTokens(model);
    case "codex":
      // Clamp to the backend cap; min() stays correct if codex is ever pointed
      // at a model whose nominal window is already below the cap.
      return Math.min(CODEX_BACKEND_CONTEXT_WINDOW_TOKENS, openaiContextWindowTokens(model));
    case "openrouter":
      return openrouterContextWindowTokens(model);
    case "deepseek":
      return deepseekContextWindowTokens(model);
    case "anthropic":
      return anthropicContextWindowTokens(model);
    case "bedrock":
      return bedrockContextWindowTokens(model);
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
    case "azure":
      // Azure serves OpenAI models, so vision follows the same model family.
      // But Azure's deployment-scoped chat/completions does NOT accept the
      // `file` content part (its content schema is text/image/audio), so a
      // native `document` part would 400 — keep nativeDocs false in Azure mode.
      return OPENAI_NATIVE_FAMILY.test(model)
        ? { vision: true, nativeDocs: false }
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

// Bedrock Converse tool use (function calling) is per-model. Every family in the
// catalog accepts a `toolConfig` EXCEPT DeepSeek, whose R1 reasoning model
// Converse rejects with a ValidationException ("This model doesn't support tool
// use"). A normal chat turn always loads tools, so without this gate a DeepSeek
// agent 400s on every turn; omitting toolConfig lets it run text-only instead.
// Denylist the known-incompatible family rather than allowlisting — the runtime
// accepts custom ids and the rest of Bedrock (Claude, Nova, Llama, Mistral)
// supports tool use, so an unrecognized id should default to attaching tools.
export function bedrockSupportsToolUse(model: string): boolean {
  return !/deepseek/i.test(model);
}

// Whether a Bedrock model can carry toolConfig on a streaming (converse-stream)
// request. Llama 4 streams fine and uses tools fine, but NOT both at once — a
// Llama 4 ConverseStream with toolConfig returns "This model doesn't support tool
// use in streaming mode" (verified live; the model card's blanket "no
// ConverseStream" wording is broader than the actual constraint). callBedrockConverse
// uses this to drop to non-stream Converse for Llama 4 only when it is attaching
// tools — tool-less Llama 4 turns still stream. Denylist the known family;
// everything else supports tools + streaming together.
export function bedrockSupportsStreamingWithTools(model: string): boolean {
  return !/llama4/i.test(model);
}
