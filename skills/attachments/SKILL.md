---
name: attachments
description: "Move bytes between Gini upload space, external URLs, and workspace files. Used by every attachment / file-upload / file-download flow regardless of the target system (Linear, GitHub, S3, Notion, etc.)."
license: MIT
allowed-tools: "skill_run vision_query read_skill"
metadata:
  gini:
    version: 1.0.0
    author: Gini
    platforms: [macos, linux]
---

# Attachments

You move bytes between three places:

- **Gini upload space** — `<id>` references for files the user attached in chat, downloaded from a URL, or promoted from workspace.
- **External URLs** — any https endpoint (signed PUT/GET URLs from APIs, raw file URLs, etc.).
- **Workspace files** — files on disk under the agent's workspace root.

This skill ships four scripts you invoke via `skill_run`, plus a recipe for each common direction. The base primitive `vision_query` (asking the model to describe an image upload) is in core, not here — combine it with the scripts below when the model needs to "see" what it just moved.

## When to use this skill

- The user attached an image and asks you to file a Linear / GitHub / Notion issue with it.
- The user pasted a URL pointing to file content (Linear attachment, GitHub raw, generic https URL) and asks you to ingest or describe it.
- `code_exec` / `terminal_exec` produced a workspace file (chart, exported PDF, downloaded artifact) and you need to send it somewhere or run `vision_query` on it.
- An MCP server returned an `assetUrl` / signed URL pointing to file content and you want to do something with the bytes.

## The four scripts

### `signed-upload` — chat-attached upload → external URL

PUT bytes from a Gini upload (chat attachment, downloaded file, promoted workspace file) to a signed URL the model obtained from an API's prepare step. Used in 3-step attachment flows: prepare via the API → `signed-upload` → finalize via the API.

```
skill_run({
  skill: "attachments",
  script: "signed-upload",
  args: {
    uploadId: "abc-123-...",        // from the user message marker, signed-download, or promote-file
    url: "https://uploads.linear.app/...?X-Goog-...",
    headers: {                       // pass through whatever the prepare step returned, verbatim
      "content-type": "image/png",
      "x-goog-content-length-range": "36116,36116"
    }
  }
})
// → { ok: true, status: 200, bytesSent: 36116 }
//   or { ok: false, status, error: "..." }
```

Only https URLs are accepted. The script never fabricates headers — pass through what the prepare step gave you. Signed URLs typically expire in 60 seconds; move immediately from prepare → PUT.

### `signed-download` — external URL → Gini upload

GET bytes from a URL and store them as a Gini upload. Used to ingest content (Linear attachment URLs, GitHub raw files, user-pasted URLs, S3 presigned downloads) into the upload-addressable space so `vision_query` or `signed-upload` can consume them.

```
skill_run({
  skill: "attachments",
  script: "signed-download",
  args: {
    url: "https://uploads.linear.app/asset/abc.png",
    headers: { authorization: "Bearer ..." },  // optional, depends on the URL
    filename: "screenshot.png"                  // optional, defaults to URL basename
  }
})
// → { ok: true, uploadId: "xyz-456-...", mimeType: "image/png", size: 36116 }
```

Only https URLs accepted. Body capped at 50MB. Inferred mime comes from the `content-type` response header; falls back to `application/octet-stream`.

### `promote-file` — workspace file → Gini upload

Register a workspace-relative file as a Gini upload. Used when `code_exec` / `terminal_exec` left a file on disk that you want to attach somewhere or run `vision_query` on.

```
skill_run({
  skill: "attachments",
  script: "promote-file",
  args: {
    path: ".charts/sales-q4.png",
    mimeType: "image/png"  // optional, sniffed from extension when omitted
  }
})
// → { ok: true, uploadId: "ghi-789-...", mimeType: "image/png", size: 24512 }
```

Path is workspace-relative and escape-protected (same guard as `file_read`).

**When the user asked you to send / show them a file** (a screenshot, a chart, a generated picture, a PDF, a CSV), `promote-file` is all you need. Its result includes an `attachmentMarkdown` field — a ready-to-paste markdown tag like `![image](gini-upload://<id>)` (for images) or `[name](gini-upload://<id>)` (for other files). **Paste that tag verbatim into your reply at the spot where the attachment should appear** — it renders inline there (an image shows as a picture, any other file as a download chip), so you can place a screenshot mid-sentence, right where you're describing it. Do **not** paste the raw `uploadId` on its own — use the provided `attachmentMarkdown` tag. The bare `uploadId` is only an argument to a *follow-up* tool (`signed-upload`, `vision_query`, `materialize`), never user-facing text.

### `materialize` — Gini upload → workspace file

The inverse of `promote-file`: write a Gini upload's bytes to a workspace file. Used when you need a chat-attached (or downloaded / promoted) upload on disk so `terminal_exec`, `code_exec`, or a git flow can read the actual file — e.g. committing an image to an asset branch.

```
skill_run({
  skill: "attachments",
  script: "materialize",
  args: {
    uploadId: "abc-123-...",   // from the user message marker, signed-download, or promote-file
    path: "assets/diagram.png" // optional, workspace-relative; defaults to the manifest filename
  }
})
// → { ok: true, path: "assets/diagram.png", absPath: "/abs/.../assets/diagram.png",
//     mimeType: "image/png", size: 36116, filename: "diagram.png" }
```

Destination is workspace-relative and escape-protected (same guard as `promote-file`). When `path` is omitted it defaults to the upload's original filename (basename, sanitized) at the workspace root, or `<uploadId>.<ext>` when the manifest has none. `absPath` is the absolute on-disk path — hand it to commands that need an absolute path (e.g. `git hash-object -w <absPath>`).

## Recipe patterns

### Filing an issue with a chat-attached screenshot (providers with a signed-upload API)

Applies to providers that expose a public prepare → PUT → finalize upload API (Linear, S3 / any presigned-URL backend):

1. **Prepare** — call the provider's prepare-upload tool via `mcp_call`. Linear: `prepare_attachment_upload({issue, filename, contentType, size})`. The response carries the signed URL, headers to send verbatim, and an asset URL for the finalize step.
2. **PUT bytes** — `skill_run({skill: "attachments", script: "signed-upload", args: {uploadId, url: <prepared.url>, headers: <prepared.headers>}})`.
3. **Finalize** — call the provider's finalize tool. Linear: `create_attachment_from_upload({issue, assetUrl, title})`.

`uploadId` is in the user message marker: `Attached image uploads (in order): - <id> (<mime>, <bytes> bytes)`. Read the mime and size from the same marker so the prepare call doesn't fail with `EntityTooLarge` / `EntityTooSmall`.

Targets without a public upload API (e.g. GitHub issues) don't use this recipe — `materialize` the upload to disk instead (recipe below) and follow that integration skill's own attach flow.

### Reading a screenshot the user posted as a URL

1. `skill_run({skill: "attachments", script: "signed-download", args: {url}})` → `{uploadId}`.
2. `vision_query({uploadId, question: "describe this image"})` → `{answer}`.

### Describing an existing attachment on a Linear issue

1. `mcp_call({server: "linear", tool: "get_attachment", arguments: {id: "..."}})` → response includes the asset URL.
2. `skill_run({skill: "attachments", script: "signed-download", args: {url: <assetUrl>}})` → `{uploadId}`.
3. `vision_query({uploadId, question: "..."})` → `{answer}`.

### Sending a generated chart to Linear

1. Generate via `code_exec` (matplotlib / d3 / etc.), save under `./chart.png`.
2. `skill_run({skill: "attachments", script: "promote-file", args: {path: "chart.png"}})` → `{uploadId, mimeType, size}`.
3. Run the 3-step Linear flow with that `uploadId`.

### Putting a chat-attached screenshot on disk

When an integration needs the actual file (not an upload id) — e.g. a git flow that has to `git hash-object` the bytes:

1. `skill_run({skill: "attachments", script: "materialize", args: {uploadId: "<id-from-marker>"}})` → `{path, absPath}`.
2. Hand off `absPath` to the integration skill that consumes a file — it owns the provider-specific attach flow (e.g. github-issues' "Attaching an image to an issue").

### Chat-attached files are already delivered for you

When the user attaches a file in chat, the runtime delivers it to you in core — you do **not** need this skill to read it. The content arrives in the user message (a native document part, or inlined extracted text wrapped in `<<<BEGIN/END UNTRUSTED FILE <nonce>>>>` markers), and the file is already saved to your workspace at the `uploads/<id>/<name>` path named in the message. Read the workspace file directly with `file_read` / `code_exec` when you need more than the inlined preview. See ADR chat-file-attachments.md. This skill is for **agent-initiated** byte movement (URL downloads, promoting generated files, sending to an external system), not for reading the user's chat uploads.

## Rules

1. **Always invoke through `skill_run`** with `skill: "attachments"`. The scripts read JSON from stdin and write JSON to stdout — don't try to `terminal_exec` them by hand.
2. **Pass signed-upload headers through verbatim** from the prepare step's response. Omitting one or rewriting the casing usually means a 403 from the storage backend.
3. **Signed URLs expire fast** (often 60 seconds). On `signed-upload` failure, re-run the provider's prepare step rather than retrying with the stale URL.
4. **Don't attempt vision on non-image uploads.** `vision_query` only accepts `image/png` and `image/jpeg`. Convert via `terminal_exec` (`sips -s format jpeg ...`) and `promote-file` the result if you need to vision a different format.
5. **The provider-specific prepare/finalize (or other attach) steps live in each integration's skill** (Linear's `SKILL.md` documents Linear's args; `github-issues` documents GitHub's attach flow). This skill owns the byte-PUT / byte-GET / materialize middle steps only.
