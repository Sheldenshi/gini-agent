# ADR: Voice Messages With Gateway-Side Local Speech-To-Text

- **Status:** Accepted
- **Date:** 2026-06-01
- **See also:** [ChatBlock Protocol](./chat-block-protocol.md), [Agent Loop With Native Tool Calling](./agent-loop-tool-calling.md)

## Decision

A recorded voice message is transcribed on the **gateway** with a
**local** speech-to-text model, and only the **transcript** ever reaches
the agent. The original audio is kept as a playable attachment on the
user message for transcript context, but it is never forwarded to the
model/provider — the agent is text-based, so audio is a render-only
artifact, not model input.

Transcription is a new local-model capability that mirrors the
embeddings/reranker pattern (`packages/runtime/src/stt.ts`): in-process Transformers.js
running `onnx-community/whisper-small` at `q8` by default, lazy-loaded on
first use, cached under the shared `~/.gini/models` dir. Selection is
env-driven (`GINI_STT_PROVIDER` = `local` | `echo`, default `local`;
`GINI_LOCAL_STT_MODEL`, `GINI_STT_DTYPE`). The `echo` provider is
**test-only** and selected solely by explicit opt-in — a local load
failure surfaces as a thrown error (which the chat path turns into a
user-facing "couldn't transcribe" message), never a fabricated
transcript.

The default is the **small** model, not large-v3-turbo, because voice
messages are short clips. Whisper always encodes a fixed 30-second
window, so the **encoder** size — not the decoder — sets the latency;
"turbo" only prunes the decoder, which speeds up long-audio decoding a
short message never needs. On CPU, `whisper-small` transcribes a ~5s
clip in ~1.5s (vs ~14s for large-v3-turbo) at a ~237 MB download. For
small models CPU beats the WebGPU/CoreML execution providers (GPU
dispatch overhead dominates), so no GPU plumbing is used. Operators who
want maximum accuracy on hard audio can set
`GINI_LOCAL_STT_MODEL=onnx-community/whisper-large-v3-turbo` with
`GINI_STT_DTYPE=q4`.

## Context

Issue #207 asked for Telegram-style push-to-record voice messages in the
mobile app. Gini's agent loop consumes text (and, on the vision path,
images) — it has no audio input. Two boundaries had to be decided:

1. **Where transcription happens, and what the model sees.** The model
   must not receive raw audio. Doing speech-to-text on-device would tie
   the feature to one platform's recognizer and split the contract
   across clients; sending audio to the provider would change the data
   that crosses the trust boundary and depend on provider audio support.
   Transcribing on the gateway with a local model keeps audio bytes off
   the provider entirely and keeps every client a thin recorder.

2. **How audio is decoded without new system dependencies.** The
   embeddings/reranker providers run Transformers.js in-process with no
   external binaries. The ASR pipeline wants 16 kHz mono PCM. Decoding
   arbitrary compressed audio (webm/opus, m4a/AAC) in Node would pull in
   ffmpeg. Recording uncompressed PCM on the client side-steps that.

## Required Now

- **`packages/runtime/src/stt.ts`** — `SttProvider` abstraction with `local` and `echo`
  implementations, mirroring `packages/runtime/src/embeddings.ts`/`packages/runtime/src/reranker.ts`
  (lazy dynamic import, warn-once, `~/.gini/models` cache, a test seam).
  A pure-JS WAV decoder reads the RIFF header and yields a
  `Float32Array` of 16 kHz mono samples (16-bit PCM, stereo downmix,
  linear resample), with implausible sample rates rejected before
  allocation. `sttStatus()` / `isLocalSttModelCached()` report readiness
  for the active dtype without loading the model.

- **WAV-on-device.** Clients record **16 kHz mono 16-bit LinearPCM WAV**
  so the gateway decodes the bytes directly and feeds the pipeline — no
  ffmpeg, no subprocess. iOS produces this via `expo-audio`
  (`IOSOutputFormat.LINEARPCM`); the mic affordance is therefore offered
  on **iOS only** (Android/web `MediaRecorder` cannot emit a decodable
  WAV through this path).

- **Client contract.**
  - `POST /api/uploads` accepts `audio/*` (in addition to `image/*`);
    bytes land in the same upload store and are served by
    `GET /api/uploads/:id` for playback (Bearer-authed). That GET honors
    HTTP `Range` (responds `206 Partial Content` with `Content-Range`,
    advertises `Accept-Ranges: bytes`, and `416` for an unsatisfiable
    range): iOS `AVPlayer` (which backs the mobile voice bubble's
    `expo-audio` player) will not start a remote audio `AVURLAsset` unless
    the origin supports byte-range requests, so without range support the
    player never loads an item and the bubble's play control is inert. The
    range path applies to every upload type but only audio playback
    depends on it.
  - `POST /api/chat/:id/messages` accepts an optional `audio` attachment
    ref `{ id, mimeType, size, durationMs? }`. When `content` is empty
    and `audio` is present, the gateway validates the **stored** upload
    mime is `audio/*`, transcribes, and sets `content` to the transcript
    before creating the run/task. A failed or empty transcription is
    rejected (no blank turn); the session is re-validated after the
    (possibly long) transcription so a delete mid-transcribe can't leave
    orphan work.
  - `GET /api/stt/status` → `{ provider, model, ready }` lets a client
    warn before the first voice message that the local model still needs
    its one-time download.

- **Persistence/render.** `user_text` ChatBlocks and `ChatMessageRecord`
  carry an optional `audio: AudioAttachment` (upload ref), alongside the
  existing `images`. Clients render a playable bubble from the upload id
  plus the transcript text. The attachment is render-only — it is never
  added to the provider message (see [ChatBlock Protocol](./chat-block-protocol.md)).

## Consequences

Pro:

- Audio never crosses the provider trust boundary; the model only ever
  sees transcript text. The feature works with any text provider.
- Speech-to-text is fully local and offline-capable after the one-time
  model download, with no new system dependency (no ffmpeg).
- Clients stay thin recorders; the transcription contract lives in one
  place on the gateway.

Con:

- The first voice message blocks on a ~237 MB model download + load
  (synchronous on submit). The client shows a one-time "setting up"
  notice via `/api/stt/status` and a transcribing indicator, but the
  first turn is slow.
- WAV is uncompressed (~32 KB/s), so a voice message upload is larger
  than an encoded clip. Acceptable for short messages, and the recording
  format is fixed at 16 kHz mono to bound it.
- Reliable recording is iOS-only for now; Android/web would need a
  decodable upload format (or gateway-side decoding) before the mic is
  offered there.

## Acceptance Checks

- `bun test packages/runtime/src/stt.test.ts` covers provider selection, the WAV decoder
  (downmix, resample, rejected formats/sample-rates), dtype-aware
  readiness, and the local provider via the test seam (including that a
  load failure rejects rather than echoing a placeholder).
- `bun test packages/runtime/src/execution/chat.test.ts` covers transcribe-on-submit,
  rejection of failed/empty transcriptions, stored-mime validation of
  the audio attachment, and the post-transcription session re-check.
- `bun test packages/runtime/src/http.test.ts` covers `GET /api/uploads/:id` range
  semantics: full-body `200` with `Accept-Ranges`, bounded/mid/open-ended/
  suffix `206` slices with the right `Content-Range`, end clamping, `416`
  for a start past EOF (and a zero-byte file), and malformed ranges
  falling back to the full body. `HEAD` advertises `Accept-Ranges`.
- `bun test packages/mobile/src/components/chat/BlockUserText.test.tsx` covers the
  voice bubble's play/pause toggle — including that replaying a finished
  clip rewinds to 0 (awaiting `seekTo`) **before** `play()`, so the
  AVQueuePlayer restarts at the beginning instead of at the end.
- Live-gateway verification: a recorded 16 kHz WAV uploaded to
  `/api/uploads`, posted to `/api/chat/:id/messages` with empty content,
  is transcribed by the local whisper model into the message content and the
  `user_text` block carries the `audio` attachment, while the task input
  is transcript-only (no audio reaches the provider).
- Live-mobile verification: tapping the voice bubble's play control on the
  iOS simulator starts playback (the control flips to pause, the track
  fills, the countdown advances), and tapping again after the clip ends
  replays it from the start.
