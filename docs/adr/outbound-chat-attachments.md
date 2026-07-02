# Outbound Chat Attachments — Agent → User Images

## Status

Accepted.

## Context

The chat block protocol carried media in one direction only. A user could
attach images and files to a message — they ride on `UserTextBlock.images`
(`ImageAttachment[]`) and `UserTextBlock.audio`, with bytes stored on disk
under `uploads/<id>.<ext>` and fetched by clients via `GET /api/uploads/:id`.
But the agent had no symmetric channel: `AssistantTextBlock` carried only
`text` + `streaming`, `ToolResultBlock` carried only a truncated `preview`
string + a `truncated` flag, and the `ChatBlock` union had no outbound-media
member. When the agent produced an image — a browser screenshot, a generated
chart, a promoted workspace file — the bytes had nowhere to land in the wire
protocol, so they never rendered for the user.

The `browser_vision` tool made the gap explicit: it captured a PNG, sent it to
a vision model for a *text* answer, and discarded the pixels, with an in-code
comment noting "there is no transport for an image tool result yet." Meanwhile
`skills/attachments/scripts/promote-file.ts` already minted an
`{ uploadId, mimeType, size }` for a workspace file — the agent-side "produce
bytes → get a referenceable id" half was built; only the chat-render half was
missing.

The upload store and HTTP routes were already symmetric and author-gate-free:
`storeUpload`/`readUpload` (`packages/runtime/src/state/uploads.ts`) take no author parameter,
`POST /api/uploads` validates only mime + size, and `GET /api/uploads/:id`
serves bytes to any bearer-authed client. So agent-authored bytes can use the
exact same storage and serving path as user uploads — no new endpoint needed.

## Decision

An agent-produced attachment renders **inline in the reply text** via a
markdown reference the model itself places — exactly where the picture belongs
in its prose (so an image can land mid-sentence, between paragraphs the model
wrote), symmetric with how all the agent's other markdown renders inline.

The canonical reference is a dedicated scheme, `gini-upload://<id>`
(`packages/runtime/src/lib/upload-ref.ts`). Image-producing tools hand the model a ready-to-paste
markdown tag in their result; the model drops it into its reply; each client
rewrites the ref to its own authed image source when rendering.

Specific choices:

- **Reference lives in the reply text, not a structured block field.** Only the
  model knows where in its prose an image belongs, so the reference must be
  authored into the reply itself — no runtime-only field can place an image
  mid-sentence. Markdown SYNTAX carries the kind: an image → `![alt](gini-upload://<id>)`
  (renders inline as a picture); any other file → `[name](gini-upload://<id>)`
  (renders a download chip). This makes the feature **arbitrary-file-general** —
  `promote-file` can attach a PDF, CSV, or log, not just images.

- **A dedicated scheme, not a real URL.** `gini-upload://` can't collide with a
  genuine external URL, so each client's markdown renderer hard-allowlists it and
  never AUTO-FETCHES any other image `src` — closing the SSRF / tracking-pixel
  surface that arbitrary model-authored markdown images would otherwise open. A
  foreign `http(s)` image isn't loaded inline; it renders an inert chip (naming
  the image + host) that fetches only on an explicit click, mirroring how a
  foreign text link behaves. A non-`http(s)` `src` (`data:`/`javascript:`) is
  dropped entirely. No single real URL would work cross-client anyway: web uses a
  relative `/api/runtime/uploads/<id>` (BFF injects the bearer), while mobile/CLI
  use an absolute `<gatewayOrigin>/api/uploads/<id>` + a bearer header.

- **Tools hand the model a ready-to-paste tag, not a raw id.** `browser_vision`
  (`packages/runtime/src/tools/browser.ts`) returns `imageMarkdown` in its envelope;
  `skill_run attachments/promote-file` has `withPromoteFileAttachmentTag`
  (`packages/runtime/src/execution/tool-dispatch.ts`) add an `attachmentMarkdown` tag for ANY
  successful promote (image tag for an image mime, link tag otherwise). Handing
  the model an exact string to copy is far more reliable than asking it to build
  markdown from a UUID. The `attachments` skill steer tells the model to paste
  the provided tag where the attachment should appear.

- **Per-client renderers.** Web `MarkdownContent` (`packages/web/src/components/chat/MarkdownContent.tsx`)
  overrides the `img`/`a` components to rewrite an upload ref to the BFF URL
  (with a custom `urlTransform` so react-markdown's sanitizer doesn't strip the
  scheme first). An image ref becomes an inline `<img>`; a non-image ref becomes
  a paperclip download chip. Mobile `BlockAssistantText`
  (`packages/mobile/src/components/chat/BlockAssistantText.tsx`) overrides the markdown
  `image` rule to render `AuthedImage` (bearer on native, blob fetch on web — RN
  Web's `<img>` can't send a header) and the `link` rule to render the non-image
  chip inline. Neither AUTO-FETCHES a non-upload ref: a foreign `http(s)` image
  renders an inert chip (alt + host) that loads only on an explicit tap/click —
  a role=link span on web (so a linked image can't form an invalid nested
  anchor), a Pressable on mobile (which, like the upload image, makes its
  paragraph escape the iOS text-selection wrapper to a plain View host). A
  non-`http(s)` `src` is dropped entirely.

- **A non-image chip OPENS A PREVIEW, not a forced download.** `GET
  /api/uploads/:id` defaults to `content-disposition: attachment`, but `?inline=1`
  opts a safe-allowlisted upload into `content-disposition: inline`
  (`resolveInlineUpload` in `packages/runtime/src/http.ts`): PDFs + raster images keep their real
  type, while `.md` / `.csv` / `.json` / `.txt` are coerced to `text/plain` so a
  text upload previews as raw text rather than executing as a document.
  Unsafe/unknown mimes (html, svg, xml, octet-stream) ignore the flag and still
  download. The web chip opens the inline URL in a new tab (the browser's own
  PDF/text viewer); the BFF injects the bearer server-side so a bare URL works.

- **Mobile uses a SIGNED capability URL so the chip opens the in-app browser.**
  A mobile in-app browser (`SFSafariViewController` / Custom Tabs) can't attach
  the bearer header — and as of iOS 11 `SFSafariViewController` shares no cookies
  — so it can't open `/api/uploads/:id` directly. Instead the chip mints a
  short-lived SIGNED url: `POST /api/uploads/:id/sign` (bearer-authed) returns a
  path carrying `?inline=1&exp=&sig=`, where `sig` is `HMAC-SHA256(<id>.<exp>)`
  keyed by the owner `config.token` (`packages/runtime/src/lib/upload-signing.ts`). The
  `authorized()` gate (`packages/runtime/src/http.ts`) accepts a valid, unexpired signature as an
  alternative to a bearer, but ONLY for a GET/HEAD of that exact upload id, so a
  signed url authorizes one file until it expires and nothing else. The mobile
  chip (`openUploadInBrowser`) mints then opens the signed url via the in-app
  browser; if minting fails it falls back to the download-then-OS-share path
  (`openUploadAttachment` → `FileSystem.downloadAsync` → Quick Look). This is an
  S3-presigned-GET model: permission rides the url, the signing secret never
  leaves the gateway, and `exp` (clamped to 30–600s) bounds the leak window of a
  url that lands in browser history or a log.

- **Reuse the upload store + `GET /api/uploads/:id`.** No new media endpoint.
  Bytes are stored via `storeUpload` and served from the existing route. The blob
  reader (`resolveBlobPath` in `packages/runtime/src/state/uploads.ts`) tolerates writer extension
  drift: `storeUpload` and the `promote-file` skill script choose a file
  extension from independent mime→ext maps that can disagree (e.g. `text/markdown`
  → `.md` from promote-file but `markdown` from `extensionFor`), so the reader
  tries the computed extension first and then falls back to any `<id>.<ext>` blob
  in the dir (excluding the `.json` manifest and `.vis-*.jpg` vision caches) —
  otherwise a promoted markdown file 404s though it's plainly on disk. The CLI
  (which can't show pixels) parses refs from the reply text and saves the bytes
  to a temp file.

- **Screenshot secret-redaction parity is preserved for free.** The bytes
  stored as the upload are the SAME bytes sent to the vision model — already
  DOM-blurred for any `[data-gini-secret]` element before capture
  (`packages/runtime/src/tools/browser.ts`). A user-visible screenshot therefore cannot leak a
  secret the vision answer would have redacted.

- **`[SILENT]` is handled structurally.** Because the reference lives inside the
  assistant reply text, a `[SILENT]`-suppressed turn — whose reply is dropped —
  takes its attachment reference with it. No separate image-retraction step is
  needed on any surface.

- **Messaging mirror.** The Telegram reply-mirror
  (`packages/runtime/src/integrations/telegram-poller.ts`) parses upload refs out of the reply
  text and sends each IMAGE as its own caption-less photo. Text and photo are
  always separate sends — never a photo+caption — so the reply can't be lost to
  Telegram's 1024-char caption limit or a photo-send failure. When it rewrites
  the markdown tags out of the displayed text (Telegram can't render them) it
  drops a tag only when that image was actually sent; for any other ref — a
  non-image file, or an image that failed to resolve — it keeps the visible
  filename LABEL so the attachment never silently vanishes. A `[SILENT]` turn
  sends nothing. Telegram `sendDocument` for non-image attachments is deferred,
  as are Discord photo sends (both stubbed).

## Consequences

- An agent screenshot / promoted file now renders **inline, mid-prose** in the
  reply on web and mobile, mirrors to Telegram, and saves to disk on the CLI —
  the original gap ("screenshots from the agent never arrive") is closed, and
  the image sits where the model put it rather than in a separate card.
- The block schema is UNCHANGED — `AssistantTextBlock` / `ToolResultBlock` carry
  no new field, no `chat_blocks` migration, no new render item. The reference is
  ordinary reply text.
- Rendering depends on the model placing the tag. A forgotten tag means no
  inline image (a graceful miss), which the ready-to-paste tag + skill steer
  make reliable.
- The model sees the upload id (it's in the tool result and the reply text). The
  id references the agent's own just-captured, secret-blurred bytes, so it
  grants no capability the agent didn't already have.

## Acceptance checks

- A real chat turn ("take a screenshot of lego.com and send it to me") produces
  a reply whose text contains `![…](gini-upload://<id>)`; the web/mobile chat
  renders the screenshot inline in the reply bubble, and `GET /api/uploads/:id`
  serves the PNG.
- `MarkdownContent` rewrites a `gini-upload://` image ref to the BFF URL and
  does NOT auto-fetch a foreign `https://` image src — it renders an inert
  click-to-open chip (SSRF / tracking-pixel guard), while a `data:`/`javascript:`
  src is dropped entirely.
- `uploadIdsFromText` / `uploadIdFromRef` extract ids from reply text / a single
  ref and reject non-upload values.
- A real chat turn that sends a PDF + a markdown file produces a reply whose text
  contains `[name](gini-upload://<id>)` for each; the web/mobile chat renders each
  as a named chip, and `GET /api/uploads/:id?inline=1` serves the PDF as
  `application/pdf` inline and the markdown as `text/plain` inline (both
  previewable), while an SVG/HTML upload keeps `content-disposition: attachment`.
- A promoted `text/markdown` upload (blob on disk as `<id>.md`) is served, not
  404'd — the reader resolves the blob despite the `extensionFor` mismatch.
- `POST /api/uploads/:id/sign` (bearer-authed) returns a signed `?inline=1&exp=&sig=`
  path; a GET of that path with NO bearer returns 200 inline, while an unsigned
  bearer-less GET, an expired signature, a sig for a different id, and an
  unauthenticated mint all return 401. The mobile chip mints then opens the
  signed url in the in-app browser.
- The Telegram mirror sends the image as a photo and strips the tag from the
  text; a `[SILENT]` turn sends nothing.
- 100% line/function coverage on every touched source file.
