// Speech-to-text provider abstraction. Mirrors src/embeddings.ts /
// src/reranker.ts: the agent is text-based, so audio is transcribed at the
// gateway and only the transcript ever reaches the model.
//
// Two implementations:
//   - local: in-process Transformers.js automatic-speech-recognition
//            pipeline running onnx-community/whisper-small at q8 by default.
//            small (not turbo/large) because voice messages are short clips:
//            whisper always encodes a fixed 30s window, so the encoder size —
//            not the decoder — sets the latency. small transcribes a short
//            clip in ~1.5s on CPU (~30x faster than large-v3-turbo) at ~237MB.
//            Override the model/dtype with GINI_LOCAL_STT_MODEL / GINI_STT_DTYPE
//            (e.g. onnx-community/whisper-large-v3-turbo + q4 for max accuracy).
//            Pure JS + native onnxruntime; no external service, no ffmpeg.
//            Lazy-imports `@huggingface/transformers` only on first use so the
//            native-binding + model download cost is paid only when someone
//            actually records a voice message.
//   - echo:  deterministic stub. transcribe() always returns "[voice
//            message]" — for tests + offline dev so the chat path works
//            without downloading whisper. Test-only: never a production
//            fallback (it would post fabricated content), so it is selected
//            ONLY by an explicit GINI_STT_PROVIDER=echo opt-in.
//
// Selection priority (mirrors embeddings/reranker):
//   1. GINI_STT_PROVIDER=echo (explicit opt-in) — echo, for tests/offline dev.
//   2. Otherwise (default or GINI_STT_PROVIDER=local) — local. A load failure
//      surfaces as a thrown error from transcribe(), never a silent echo.
//
// WAV-only: clients record 16 kHz mono 16-bit LinearPCM WAV, so the gateway
// decodes the RIFF header with the tiny pure-JS parser below and feeds the
// Float32Array straight to the pipeline (which expects 16 kHz mono samples).

import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLocalModelCached } from "./local-model-cache";

// Default local model — onnx-community/whisper-small. Small keeps short-clip
// transcription fast (~1.5s on CPU) since whisper's fixed 30s-window encoder
// dominates latency; large-v3-turbo only speeds up long-audio decoding, which
// a voice message doesn't need. Override with GINI_LOCAL_STT_MODEL.
export const DEFAULT_LOCAL_STT_MODEL = "onnx-community/whisper-small";

export interface SttProvider {
  name: string;
  model: string;
  transcribe(wavBytes: Uint8Array): Promise<string>;
}

export type SttProviderName = "local" | "echo";

// What `gini doctor` / status surfaces need without instantiating anything
// heavyweight. Computed via resolveSttChoice.
export interface SttChoice {
  name: SttProviderName;
  model: string;
  reason: "explicit" | "default";
  cacheDir?: string;
}

export function localCacheDir(): string {
  // Shared with embeddings + reranker — single cache dir for all local HF
  // models so disk-usage reporting agrees across providers.
  return join(homedir(), ".gini", "models");
}

function localModelId(): string {
  const override = process.env.GINI_LOCAL_STT_MODEL;
  return override && override.length > 0 ? override : DEFAULT_LOCAL_STT_MODEL;
}

function localDtype(): string {
  const override = process.env.GINI_STT_DTYPE;
  return override && override.length > 0 ? override : "q8";
}

// Pure-data view of the configured STT choice. Doesn't trigger a model
// download; the caller must call `getSttProvider()` for that.
export function resolveSttChoice(): SttChoice {
  const explicit = (process.env.GINI_STT_PROVIDER ?? "").toLowerCase();
  if (explicit === "echo") {
    return { name: "echo", model: "echo-stt-v0", reason: "explicit" };
  }
  if (explicit === "local") {
    return {
      name: "local",
      model: localModelId(),
      reason: "explicit",
      cacheDir: localCacheDir()
    };
  }
  // Default is local. Echo is only ever selected by an explicit
  // GINI_STT_PROVIDER=echo (test/offline opt-in); a local load failure never
  // silently swaps in echo, so the status signal always reflects local here.
  return {
    name: "local",
    model: localModelId(),
    reason: "default",
    cacheDir: localCacheDir()
  };
}

// Maps a Transformers.js dtype to the ONNX filename suffix the model is cached
// under (mirrors DEFAULT_DTYPE_SUFFIX_MAPPING in @huggingface/transformers).
const DTYPE_FILE_SUFFIX: Record<string, string> = {
  fp32: "",
  fp16: "_fp16",
  int8: "_int8",
  uint8: "_uint8",
  q8: "_quantized",
  q4: "_q4",
  q2: "_q2",
  q1: "_q1",
  q4f16: "_q4f16",
  q2f16: "_q2f16",
  q1f16: "_q1f16",
  bnb4: "_bnb4"
};

// Whether the local model's onnx weights for the ACTIVE dtype are already on
// disk, so the first voice message can be transcribed without the one-time
// model download. The onnx-community build stores the encoder + merged decoder
// under <cacheDir>/<modelId>/onnx with a dtype-specific suffix (q4 → _q4, q8 →
// _quantized, fp32 → "", ...). The check keys off the configured dtype so a
// dtype the loader will fetch but hasn't cached reports not-ready (rather than
// claiming ready and then blocking the first request on a download). For an
// unrecognized or "auto" dtype, where the resolved filename can't be predicted,
// it falls back to "any encoder + merged-decoder pair present". Pure disk
// check; no model load, no download.
export function isLocalSttModelCached(modelId: string = localModelId()): boolean {
  const onnxDir = join(localCacheDir(), modelId, "onnx");
  let files: string[];
  try {
    files = readdirSync(onnxDir);
  } catch {
    return false;
  }
  const suffix = DTYPE_FILE_SUFFIX[localDtype()];
  if (suffix === undefined) {
    return (
      files.some((f) => f.startsWith("encoder_model") && f.endsWith(".onnx")) &&
      files.some((f) => f.startsWith("decoder_model_merged") && f.endsWith(".onnx"))
    );
  }
  return (
    files.includes(`encoder_model${suffix}.onnx`) &&
    files.includes(`decoder_model_merged${suffix}.onnx`)
  );
}

// Lightweight readiness signal for clients. `ready` is true when a voice
// message can be transcribed immediately: always for echo, and for local only
// once the model weights are cached (otherwise the first request blocks on a
// one-time download). No model load, no download.
export function sttStatus(): { provider: SttProviderName; model: string; ready: boolean } {
  const choice = resolveSttChoice();
  return {
    provider: choice.name,
    model: choice.model,
    ready: choice.name === "echo" ? true : isLocalSttModelCached(choice.model)
  };
}

// Track local-provider load failures so we don't spam the same warning per
// transcribe call and don't retry the load on every voice message. Once it
// fails, transcribe() throws immediately for the rest of the process lifetime.
let localProviderUnavailable: { reason: string } | null = null;

export function getSttProvider(): SttProvider {
  // Echo is test/offline only: select it solely when GINI_STT_PROVIDER is
  // explicitly "echo". For the default and explicit "local", always return the
  // local provider — a load failure surfaces as a thrown error from
  // transcribe(), never a fabricated "[voice message]" transcript.
  const explicit = (process.env.GINI_STT_PROVIDER ?? "").toLowerCase();
  if (explicit === "echo") return echoProvider();
  return localProvider(localModelId());
}

// --------------------------------------------------------------------------
// Local provider — in-process Transformers.js ASR pipeline.
// --------------------------------------------------------------------------

// The pipeline takes a Float32Array of 16 kHz mono samples and returns
// `{ text }`. Transformers.js exposes the onnx-community quantized ONNX
// builds at this path verbatim.
type Transcriber = (
  audio: Float32Array,
  options?: { chunk_length_s?: number; stride_length_s?: number }
) => Promise<{ text: string } | Array<{ text: string }>>;

// Cached per (model, dtype) so concurrent callers during cold start don't
// double-load. Value is a promise so cold-start races collapse onto one load.
const pipelineCache = new Map<string, Promise<Transcriber>>();

// Test seam — replace the dynamic-import path so unit tests can exercise the
// local provider without touching the network or the native binding. Setting
// to null restores the real import.
type TransformersModule = {
  pipeline: (task: string, model: string, options?: { dtype?: string }) => Promise<Transcriber>;
  env: { cacheDir?: string; allowRemoteModels?: boolean };
};
let transformersLoader: (() => Promise<TransformersModule>) | null = null;
export function __setTransformersLoaderForTests(loader: (() => Promise<TransformersModule>) | null): void {
  transformersLoader = loader;
  pipelineCache.clear();
  localProviderUnavailable = null;
}

async function loadTranscriber(modelId: string): Promise<Transcriber> {
  const dtype = localDtype();
  const key = `${modelId}::${dtype}`;
  const existing = pipelineCache.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<Transcriber> => {
    const cacheDir = localCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    process.env.HF_HOME ??= cacheDir;
    process.env.TRANSFORMERS_CACHE ??= cacheDir;

    // Never import the real module under bun test: it dlopens the
    // onnxruntime NAPI addon, whose deferred finalizers can fire after a
    // --parallel/--isolate worker has swapped globals and segfault the
    // worker (napi_open_escapable_handle_scope; surfaced via issue #289).
    // Tests that exercise this path inject __setTransformersLoaderForTests;
    // everything else degrades through the catch below, same as a failed
    // model load in production.
    if (!transformersLoader && process.env.NODE_ENV === "test") {
      throw new Error("@huggingface/transformers is not loaded under bun test; inject __setTransformersLoaderForTests");
    }
    const mod = transformersLoader
      ? await transformersLoader()
      : (await import("@huggingface/transformers")) as unknown as TransformersModule;
    if (mod.env) mod.env.cacheDir = cacheDir;

    // First-use download notice. Transformers.js nests the model under
    // <cacheDir>/<org>/<model>/, so checking that nested directory (not a flat
    // top-level scan) tells us whether this model is already cached and the
    // notice should print.
    const looksUncached = !isLocalModelCached(cacheDir, modelId);
    if (looksUncached) {
      process.stderr.write(`Downloading speech-to-text model ${modelId}... this happens once.\n`);
    }

    return await mod.pipeline("automatic-speech-recognition", modelId, { dtype });
  })().catch((error) => {
    pipelineCache.delete(key);
    const message = error instanceof Error ? error.message : String(error);
    if (!localProviderUnavailable) {
      process.stderr.write(`Local speech-to-text provider unavailable (${message}); voice transcription will error until resolved.\n`);
    }
    localProviderUnavailable = { reason: message };
    throw error;
  });
  pipelineCache.set(key, promise);
  return promise;
}

export function localProvider(modelId: string = localModelId()): SttProvider {
  return {
    name: "local",
    model: modelId,
    async transcribe(wavBytes: Uint8Array): Promise<string> {
      // Once the model load has failed in this process, fail fast rather than
      // retrying the load on every voice message. loadTranscriber sets this on
      // its first failure, so this guarantees an error (never echo) on the
      // local path after a load failure.
      if (localProviderUnavailable) {
        throw new Error(`Local speech-to-text unavailable: ${localProviderUnavailable.reason}`);
      }
      const samples = decodeWav(wavBytes);
      const transcriber = await loadTranscriber(modelId);
      const result = await transcriber(samples, { chunk_length_s: 30, stride_length_s: 5 });
      const text = Array.isArray(result) ? (result[0]?.text ?? "") : result.text;
      return cleanTranscript(text);
    }
  };
}

// Whisper emits a non-speech marker for silence/empty audio. Treat it (and
// pure whitespace) as no transcript so the message posts with just the audio
// bubble rather than literal "[BLANK_AUDIO]".
function cleanTranscript(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "[BLANK_AUDIO]") return "";
  return trimmed;
}

// --------------------------------------------------------------------------
// Echo provider — deterministic stub for tests + offline dev.
// --------------------------------------------------------------------------

export function echoProvider(): SttProvider {
  return {
    name: "echo",
    model: "echo-stt-v0",
    async transcribe(_wavBytes: Uint8Array): Promise<string> {
      return "[voice message]";
    }
  };
}

// --------------------------------------------------------------------------
// WAV decoder — pure JS RIFF/WAVE parser. Returns a Float32Array of mono
// samples normalized to [-1, 1] at 16 kHz, which is what the ASR pipeline
// expects. Supports 16-bit PCM primarily; downmixes stereo→mono and
// linear-resamples to 16 kHz when needed. Throws on non-PCM/unsupported.
// --------------------------------------------------------------------------

const TARGET_SAMPLE_RATE = 16000;

export function decodeWav(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) throw new Error("WAV decode failed: file too small.");
  if (readTag(view, 0) !== "RIFF" || readTag(view, 8) !== "WAVE") {
    throw new Error("WAV decode failed: not a RIFF/WAVE file.");
  }

  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  // Walk the chunk list. Chunk bodies are word-aligned (an odd size is
  // followed by a pad byte), so advance by size + (size & 1).
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = readTag(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(bodyOffset, true);
      numChannels = view.getUint16(bodyOffset + 2, true);
      sampleRate = view.getUint32(bodyOffset + 4, true);
      bitsPerSample = view.getUint16(bodyOffset + 14, true);
    } else if (chunkId === "data") {
      dataOffset = bodyOffset;
      // Clamp to the actual buffer in case the header over-reports.
      dataLength = Math.min(chunkSize, bytes.length - bodyOffset);
    }
    offset = bodyOffset + chunkSize + (chunkSize & 1);
  }

  if (dataOffset < 0) throw new Error("WAV decode failed: no data chunk.");
  // 1 = PCM (integer). 3 = IEEE float. We only handle integer PCM.
  if (audioFormat !== 1) {
    throw new Error(`WAV decode failed: unsupported audio format ${audioFormat} (only 16-bit integer PCM is supported).`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`WAV decode failed: unsupported bit depth ${bitsPerSample} (only 16-bit PCM is supported).`);
  }
  if (numChannels < 1) throw new Error("WAV decode failed: invalid channel count.");
  // Reject implausible sample rates before allocating. A forged header with a
  // tiny rate would make the resample ratio approach zero and the output
  // length explode; clamping to a sane range bounds the resampled output to a
  // small multiple (≤4×) of the input frame count.
  if (sampleRate < 4000 || sampleRate > 192000) {
    throw new Error(`WAV decode failed: unsupported sample rate ${sampleRate}.`);
  }

  const bytesPerSample = 2;
  const frameCount = Math.floor(dataLength / (bytesPerSample * numChannels));
  const mono = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    const frameStart = dataOffset + frame * bytesPerSample * numChannels;
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = view.getInt16(frameStart + ch * bytesPerSample, true);
      sum += sample / 32768;
    }
    // Average channels to downmix stereo (or more) → mono.
    mono[frame] = sum / numChannels;
  }

  return sampleRate === TARGET_SAMPLE_RATE ? mono : resampleLinear(mono, sampleRate, TARGET_SAMPLE_RATE);
}

// Linear interpolation resampler. Whisper needs 16 kHz; clients should record
// at 16 kHz directly, but a tiny resampler keeps the decoder robust to other
// rates (and macOS test WAVs at other rates).
function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const left = Math.floor(srcPos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = srcPos - left;
    out[i] = input[left]! * (1 - frac) + input[right]! * frac;
  }
  return out;
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}
