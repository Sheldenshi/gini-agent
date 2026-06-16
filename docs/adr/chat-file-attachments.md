# ADR: Chat File Attachments — Capability-Driven Delivery

- **Status:** Accepted
- **See also:** [ChatBlock Protocol](./chat-block-protocol.md), [Attachments skill](../../skills/attachments/SKILL.md), [BFF Trust Boundary](./bff-trust-boundary.md)

## Decision

A user-attached **non-image file** (PDF, CSV, log, code, docx, xlsx, …) is delivered to the model **deterministically, in core, with no skill dependency**. At task-build time the runtime always **materializes** the file into the agent's workspace, then delivers its content one of three ways, chosen by the active provider's capability:

1. **Native** — when the resolved provider ingests documents natively, send a provider-native `document` content part (v1: PDF only).
2. **Extracted text** — otherwise, extract the file to text and inline it (capped, wrapped in untrusted-content boundary markers).
3. **Path reference** — for formats we don't extract, point the model at the materialized workspace path.

This replaces an earlier design where a non-image upload was only *named* in the user message and the model had to invoke the `attachments` skill's `materialize` script to read it. That coupled a core product capability (attach a file, agent uses it) to a skill that can be disabled or change, and to a non-deterministic multi-step tool dance. The new path is core and deterministic: in the common case the agent answers from the content with **zero tool calls**.

The **image path** is gated on the same capability record: on a non-vision provider an image attachment degrades to a text note instead of an `image_url` part — on the arrival turn the note carries a steering directive so the agent refuses in-band, and on prior turns it stays terse (see [Image attachments and `vision`](#image-attachments-and-vision)). `vision_query` is unchanged and remains image-only.

## How a file reaches the model

For each non-image attachment, on the turn it arrives (`buildAttachmentContent` in `src/execution/chat-task.ts`):

- **Materialize** the upload bytes into `<workspace>/uploads/<id>/<sanitized-name>` (escape-protected, idempotent — `materializeUpload` in `src/capabilities/attachments-materialize-core.ts`). The full file is always on disk for `file_read` / `code_exec` / git, regardless of size.
- **Native** (`resolveProviderModality(provider).nativeDocs === true` and the file is a PDF): base64 the bytes into a `document` content part. `src/provider.ts` serializes it per API surface — `file` for chat-completions, `input_file` for `/responses`. A `document` part is **only** ever produced when `nativeDocs` is true, so it never reaches a text-only provider (echo/deepseek/local), which would reject it. `src/provider.ts` also strips `document` parts at the request-build boundary whenever the resolved provider is non-`nativeDocs`, so a task that paused for approval and resumed after an `openai → deepseek/local` provider swap can't replay a stale `document` part the new provider would 400 on.
- **Extract** (`classifyFormat` is text/pdf/docx/xlsx): `extractText` (`src/capabilities/attachment-extract.ts`) returns text — utf8 for text formats, `pdfjs-dist` (text layer, `disableWorker`) for PDF, `mammoth` for docx, `xlsx`/SheetJS for spreadsheets. The text is wrapped in `<<<BEGIN/END UNTRUSTED FILE <nonce>>>>` boundary markers carrying a random per-file nonce (the content is untrusted external data — a prompt-injection defense at the content layer; the unpredictable nonce stops file content from forging the close marker to break out of the block) and capped at **256 KB** of inline preview, with a note pointing at the full file on disk. Heavy parsers load via lazy cached dynamic import and degrade to the path-reference note on failure.
- **Path reference** (unsupported format, or extraction failed): a note naming the file and its workspace path.

**Context discipline:** inline content and native document bytes are emitted only on the turn the file arrives. Prior-turn rebuilds (`priorChatMessages`) carry only the workspace path, so a large attachment doesn't compound the context window across a conversation. The 256 KB inline cap is independent of the 50 MB upload cap.

## Image attachments and `vision`

An image is delivered as a base64 `image_url` content part — but only when the resolved provider is vision-capable. A text-only provider's request schema has no image variant, so an `image_url` part **400s the entire turn** (e.g. DeepSeek rejects it with `unknown variant 'image_url', expected 'text'`), taking the user's text question down with it. There is no fallback: `vision_query` runs against `config.provider` too, so a wholly text-only provider has no image path at all. The capability record therefore gates images in one place — `buildAttachmentContent` — and never aborts the turn:

- `buildAttachmentContent` emits an `image_url` part only when `vision` is true; otherwise it degrades the image to a text note, so a non-vision provider never receives an `image_url` part it would 400 on. This covers both the **current turn** and **prior-turn** images replayed from history, so a single image can't 400 any text turn and brick the conversation.
- On the **arrival turn** (`isCurrentTurn`), a non-vision image also appends a short steering directive inside the user turn's content parts — telling the agent it cannot see the image, not to guess its contents, and to ask the user to switch to a vision-capable model or describe it. The turn then runs normally and the agent refuses **in-band**, as an ordinary assistant turn. The directive is omitted on prior-turn replay to bound replay context.

The turn is **not** hard-rejected on a non-vision provider. An earlier design threw before any model call and surfaced the refusal as a chat `system_note`; but a `system_note` is UI-only and is never replayed into the model's context, so the model couldn't see its own prior-turn refusal and a follow-up "try again" would resolve against the wrong antecedent. Letting the agent refuse in-band makes the refusal a normal, replayable assistant turn the model can reason about on the next turn. The directive deliberately lives in the user turn's content parts, not in the system message, to preserve the byte-stable system prefix (see [Stable system prefix](./stable-system-prefix.md)). The gate keys on image MIME, so non-image attachments on a text-only provider are unaffected.

### Oversized images and the per-image byte limit

A vision-capable provider still imposes a **per-image byte ceiling**: Anthropic's Messages API (direct and via Bedrock) hard-rejects any image whose **base64-encoded** `image.source.base64` payload — the encoded string, **not** the decoded image — exceeds 5,242,880 bytes, with a server-side 400 that fails the whole turn. base64 inflates raw bytes by 4/3, so a ~3.95 MB raw photo already encodes to ~5.5 MB and trips the cap; and because images replay every turn, that oversized upload re-fires the 400 on every subsequent turn, bricking the conversation. So before emitting the `image_url` part, `buildAttachmentContent` routes the upload through `visionImageDataUrl` (`src/media/image-compress.ts`), which fits any over-limit image to the provider's ceiling:

- The ceiling comes from `resolveImageByteLimit(provider)` (`src/provider-capabilities.ts`) — a **raw-byte budget of 3,750,000 for every provider**. Because the provider caps the *encoded* payload, the raw budget is the cap converted back through the 4/3 base64 expansion (`5,242,880 × 3/4`), held a margin under the cap (target 5,000,000 encoded → 3,750,000 raw). It is universal: safe for higher-limit providers like OpenAI's 20 MB, and OpenRouter can route to an Anthropic upstream, so it shares the floor. The same budget bounds the other two senders of base64 images to the provider — `vision_query` (`src/capabilities/vision-query.ts`) and `browser_vision` screenshots (`src/tools/browser.ts`), which reject over-budget images with guidance rather than compressing. Kept as a per-provider hook for future tuning.
- **Under-limit uploads pass through untouched** — `sharp` is a lazy dynamic `import("sharp")` inside the compression path, so the heavy native libvips binding only loads on the rare oversized path (never at module-eval, which would pull libvips into every test isolate that transitively imports `chat-task` and segfault Bun's isolate workers on teardown; never at cold-start when no oversized image is sent).
- **Oversized uploads** are downscaled + re-encoded to **JPEG** (universally accepted across vision providers) via an attempt ladder: full resolution first (to preserve detail on a marginally-oversized image), then progressively smaller edge + lower quality, with a small final attempt so any decodable image converges under the limit. `.rotate()` bakes in EXIF orientation (phone photos); alpha is flattened onto white (JPEG has no transparency).
- The derived JPEG is **cached on disk** next to the original at `<id>.vis-<limit>.jpg` (`readVisionVariant`/`writeVisionVariant` in `src/state/uploads.ts`), so compression runs **once** even though images replay every turn. The original upload is never mutated.
- If an image can't be decoded (some HEIC/SVG, corrupt bytes) or can't be brought under the limit, the `image_url` is **dropped rather than sent** — the turn still completes instead of 400ing. Compression and drops are traced (`chat.image.compressed` / `chat.image.compress_failed`).

## Provider capability record

`resolveProviderModality` (`src/provider-capabilities.ts`) returns `{ vision, nativeDocs }` per provider × model, from a static record built from each provider's **API reference** (not product/app file-upload features, which are app-side text extraction). Current record:

| Provider | vision | nativeDocs | Notes |
|---|---|---|---|
| openai (gpt-4o/4.1/5.x/o-series) | yes | yes | Responses `input_file` / Chat-Completions `file`; gated on a known family — unknown model ids and custom OpenAI-compatible endpoints default false |
| openrouter (anthropic/* , google/gemini* , openai/*) | yes | yes | unified `file` part; other routed models default false |
| codex (ChatGPT backend) | yes | yes | undocumented OAuth `/responses` backend, but verified empirically (gpt-5.x): `input_file` PDF and `image_url` both read back verbatim |
| anthropic (Claude Opus/Sonnet/Haiku) | yes | yes | Messages API `image` + `document` content blocks; uniformly multimodal family, no per-model gate |
| deepseek (incl. V4) | no | no | API confirmed text-only |
| local | no (unless a vision model is loaded) | no | OpenAI-compatible text by default |
| echo | no | no | test provider |

The record is a living table — extend it as providers/models are added. Both `nativeDocs` and `vision` are enforced (see [Image attachments and `vision`](#image-attachments-and-vision) for the image gate). The conservative default has a known cost: a `local` vision model is flagged `vision: false` until per-model detection lands, so its image attachments are rejected rather than sent — the safe direction, since the alternative is a 400 on every text-only provider. OpenRouter per-model discovery via `GET /models` `architecture.input_modalities` is a planned refinement.

## Consequences

- "The agent can use an attached file" is a **core guarantee**, independent of the `attachments` skill. The skill remains for **agent-initiated** byte movement (download a URL, send to Linear, promote a generated file); its `materialize` logic is shared with the core path via `materializeUpload`.
- Native document support is **provider-specific and partial** (the reason it lives behind a capability gate with a text-extraction fallback). For the conservative-default providers, every non-image file rides the extraction/path path — which works well on its own.
- **Scanned/image-only PDFs**: native-doc providers handle them natively (the provider does page-image extraction); the text-extraction fallback yields little text for them. A render-pages-to-images fallback (for a vision-capable provider with no native doc support — essentially a local vision model) is intentionally **deferred**; `extractText` keeps a seam to return page images later.
- New dependencies: `pdfjs-dist`, `mammoth`, `xlsx` (lazy-loaded, optional at runtime — extraction degrades to a path reference if a parser fails to load). `sharp` (libvips) for image compression is likewise **lazy-loaded** via dynamic import inside the oversized-image path only — it never loads at module-eval or cold-start, and a sharp failure falls back to dropping the image, not crashing the turn.

## Acceptance Checks

- A non-image upload is materialized to `<workspace>/uploads/<id>/…` and the agent answers from its content; on a text-only provider this happens with **no** `read_skill`/`materialize`/`file_read` calls.
- A PDF on a `nativeDocs` provider is delivered as a `document` part; on a text-only provider it is inlined as extracted text. A `document` part never reaches a non-`nativeDocs` provider.
- Inlined text is wrapped in boundary markers and capped at 256 KB, with the full file on disk by path.
- A current-turn image attachment on a non-vision provider sends no `image_url` part: it degrades to a text note plus an in-band steering directive, the turn runs to completion, and the agent refuses as a normal assistant turn. A prior-turn image in history degrades to a terse text note (no directive) so it can't 400 a later text turn. On a vision-capable provider the image is delivered as an `image_url` part unchanged.
- An image whose base64 payload would exceed the provider's per-image cap (e.g. a ~4 MB raw phone photo, ~5.5 MB encoded) on a vision-capable provider is auto-compressed to a JPEG under the budget before it is sent; the vision turn completes and the model can read the image (including fine detail), and the derived JPEG is cached at `<id>.vis-<limit>.jpg` with the original upload unchanged. An undecodable or un-shrinkable image is dropped rather than sent, so the turn still completes.
- The upload gate (any plausible MIME), 50 MB cap, served-upload security (`Content-Disposition: attachment` + `nosniff`), and filename sanitization remain in force. `vision_query` still rejects non-image MIME.
