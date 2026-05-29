---
name: linear
description: "Read and write Linear issues, comments, projects, cycles, users, documents, initiatives, milestones, and more via the Linear MCP server. Attach chat-uploaded screenshots to issues."
license: MIT
allowed-tools: "mcp_call signed_upload read_skill"
metadata:
  gini:
    version: 1.0.0
    author: Gini
    platforms: [macos, linux]
    requires:
      connectors:
        - provider: linear
---

# Linear

Linear is reachable through the `mcp_call` tool. Each call hits the hosted Linear MCP server; the runtime resolves the Authorization header from the connected Linear token. You never see the token or the endpoint — you pass `server: "linear"` and a tool name.

Every Linear call has the same shape:

```
mcp_call({
  server: "linear",
  tool: "<tool name>",
  arguments: { ... }
})
```

The response is a JSON string. Parse it before reporting back to the user — Linear sometimes returns nested `pageInfo` or arrays you should summarize, not dump.

## Discovering what's available

**The full inventory of Linear MCP tools is in your system prompt** under "Configured MCP servers — linear — tools: ...". That list is authoritative; do not assume a tool doesn't exist just because it isn't called out below. The categories below give you defaults and taste; reach for tools from the inventory list whenever the user asks for something outside them.

When you're unsure of a tool's argument shape, either:
- Call `mcp_call({ server: "linear", tool: "search_documentation", arguments: { query: "..." } })` to query Linear's own docs, or
- Just try the call — the server returns a clear validation error on bad args, which is recoverable.

**Do not refuse a Linear-related ask** unless you've actually checked. "Linear doesn't support that" is a claim that requires evidence.

## Defaults and common shapes

### Issues — list / read / save

`save_issue` handles both create and update — with an `id` it updates, without one it creates.

```
mcp_call({ server: "linear", tool: "list_issues",
           arguments: { assignee: "me", state: "started" } })
mcp_call({ server: "linear", tool: "get_issue",
           arguments: { id: "LIN-123" } })
mcp_call({ server: "linear", tool: "save_issue",
           arguments: { team: "ENG", title: "Login fails on Safari 17",
                        description: "Steps to reproduce…" } })
```

Useful argument quirks Linear's tool descriptions sometimes leave terse:
- `assignee: "me"` resolves to the authenticated viewer — no user-id lookup needed.
- `team` accepts the team key (`ENG`) or UUID.
- `state` accepts either the workflow state id or its display name (`"In Progress"`, `"Done"`). Workflow state *groups* for filtering: `backlog`, `unstarted`, `started`, `completed`, `cancelled`.
- `priority` is `0|1|2|3|4` where `1` is urgent, `4` is low, `0` is no priority.
- `list_issues` truncates `description` for compactness. Follow up with `get_issue` when the user needs the full body.
- Paginate by passing the `cursor` from `pageInfo.endCursor` back into the same call.

### Attaching screenshots / images

When the user provides images in chat and asks you to file or update a Linear issue, attach them after you know the issue identifier. The flow is three steps — the middle one uses the generic `signed_upload` primitive:

1. **Prepare** — call `mcp_call({ server: "linear", tool: "prepare_attachment_upload", arguments: { issue, filename, contentType, size } })`. The response carries `uploadRequest.url`, `uploadRequest.headers`, and `assetUrl`. The signed URL expires in 60 seconds; move quickly.

2. **PUT the bytes** — call `signed_upload({ uploadId, url, headers })` with the chat-uploaded file's id (from the "Attached image upload ids" system note in the user's message) plus the `url` and `headers` from step 1's response. The runtime reads the upload off disk and PUTs it; the model never has to touch raw bytes.

3. **Finalize** — call `mcp_call({ server: "linear", tool: "create_attachment_from_upload", arguments: { issue, assetUrl, title, subtitle } })` with the `assetUrl` from step 1 and an optional `title` / `subtitle`. This creates the attachment row on the issue.

Example sequence (issue ENG-123, an image upload `abc-…` of size 36116 bytes, mime `image/png`):

```
const prep = mcp_call({
  server: "linear", tool: "prepare_attachment_upload",
  arguments: { issue: "ENG-123", filename: "screenshot.png",
               contentType: "image/png", size: 36116 }
})
// prep.uploadRequest.url + prep.uploadRequest.headers + prep.assetUrl

signed_upload({
  uploadId: "abc-...",
  url: prep.uploadRequest.url,
  headers: prep.uploadRequest.headers
})

mcp_call({
  server: "linear", tool: "create_attachment_from_upload",
  arguments: { issue: "ENG-123", assetUrl: prep.assetUrl,
               title: "Login screen — error toast" }
})
```

Each user message that carries attachments ends with a system note listing each upload's id, mime type, and size:

```
Attached image uploads (in order):
- abc-123-... (image/png, 36116 bytes)
- def-456-... (image/jpeg, 24512 bytes)
```

Read the size and mimeType from that marker — `prepare_attachment_upload` rejects requests where `size` doesn't match the actual bytes (GCS returns `EntityTooLarge` / `EntityTooSmall`). One 3-step sequence per image.

If `signed_upload` returns `ok: false`, the bytes did not land. Don't run the finalize step; either retry from step 1 (the signed URL is dead) or tell the user the upload failed and offer to paste the `assetUrl` into the issue body manually.

### Everything else (projects, cycles, comments, documents, initiatives, milestones, status updates, labels, diffs, users, teams)

Use the matching tool from the inventory list in your system prompt. The shapes are predictable: `list_*` returns an array with `pageInfo`, `get_*` takes an `id`, `save_*` creates without `id` / updates with `id`, `delete_*` takes an `id`. Examples:

```
mcp_call({ server: "linear", tool: "list_teams", arguments: {} })
mcp_call({ server: "linear", tool: "list_projects", arguments: { team: "ENG" } })
mcp_call({ server: "linear", tool: "list_cycles",
           arguments: { team: "ENG", type: "current" } })  // also "next", "previous"
mcp_call({ server: "linear", tool: "list_comments",
           arguments: { issueId: "LIN-123" } })
mcp_call({ server: "linear", tool: "save_comment",
           arguments: { issueId: "LIN-123", body: "Reproduced on macOS 14." } })
mcp_call({ server: "linear", tool: "list_issue_labels", arguments: { team: "ENG" } })
mcp_call({ server: "linear", tool: "list_issue_statuses", arguments: { team: "ENG" } })
```

For label / status names passed to `save_issue`, confirm via `list_issue_labels` / `list_issue_statuses` first — Linear returns a generic validation error otherwise.

## Limitations

- **Existing attachment bytes can't be streamed back** — `get_attachment` returns metadata, not bytes. Outbound uploads (chat → Linear) work via the 3-step sequence above.
- **No webhooks / subscriptions** — the server is request/response. For live updates, point the user at Linear's native subscriptions.
- **No batch tool** — bulk operations loop client-side.

## Rules

1. Always invoke through `mcp_call` with `server: "linear"` (or `signed_upload` for the PUT step of attachment uploads). Do not call any other tool to reach Linear.
2. **Never refuse a Linear ask without checking.** If a plausible tool is in the inventory list and the user asked for that capability, try it. If you can't tell which tool, call `search_documentation` first.
3. Confirm destructive intent before deleting an issue, comment, attachment, or status update. Linear has no undo.
4. When the user asks "what am I working on", default to `list_issues({ assignee: "me", state: "started" })` and summarize, not dump.
5. Quote issue identifiers verbatim (`LIN-123`, not `123`). Linear's deeplinks resolve those directly.
6. Never include the user's API token in a reply or in any tool argument — the runtime injects it server-side.
