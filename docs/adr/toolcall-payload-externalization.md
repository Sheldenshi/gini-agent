# ADR: Tool-Call State Payload Externalization

- **Status:** Accepted
- **See also:** [Local Runtime Architecture](./local-runtime-architecture.md), [Chat Block Protocol](./chat-block-protocol.md), [Agent Loop Tool Calling](./agent-loop-tool-calling.md)

## Decision

Large inline base64 payloads (image `data:` URLs and native-document base64) are
externalized out of `task.toolCallState.messages` into a per-instance,
content-addressed side store before that snapshot is persisted to `state.json`.
The snapshot keeps a short reference string in place of the payload; the exact
bytes are restored on resume before the messages reach any provider.

The side store lives at
`~/.gini/instances/<instance>/toolcall-payloads/<sha256>.b64`. Each file is
named by the SHA-256 of the exact payload string it holds, so identical
payloads de-duplicate and any read can be byte-verified against its reference.

## Context

`state.json` is a single JSON document parsed in full on **every** `readState`
call (250 non-test call sites — effectively every request). When a chat task
pauses at an approval gate, `runLoop` snapshots the entire in-progress
conversation onto `task.toolCallState.messages` so the turn can resume after the
user approves/denies. That conversation can contain multi-megabyte inline base64
images and PDFs.

The result, observed on a real instance: one paused (`waiting_approval`) task
carrying 11 inline image parts inflated `state.json` to 37,353,188 bytes, of
which that single task's `toolCallState` was 23,926,482 bytes (the 11 image
payloads alone were 23,541,017 bytes). Every request then paid, on that
document, a `JSON.parse` of 14.5–15.8 ms plus a `normalizeState` pass of
39.9–45.9 ms, all synchronous on the single event loop; under a 10-way
concurrent burst each request's server-side TTFB rose to a 363.5–1370.5 ms
range (versus 95.3–271.9 ms solo).

This directly violated a principle the codebase already held elsewhere:
`src/state/uploads.ts` keeps attachment bytes on disk and stores only an upload
id in durable state precisely so base64 never lands in the JSON write path.
`toolCallState` was the one place that broke it.

## Trust boundary and correctness properties

The fix is a storage-layer change confined to the snapshot writer and the resume
reader. It is designed so no consumer of `toolCallState.messages` other than
those two sites needs to change, and so a missing payload fails loudly rather
than silently.

- **Surface.** Only two sites move bytes: the snapshot write in
  `runLoop` (dehydrate) and the resume read in `resumeChatTask` (rehydrate). The
  reference replaces only the **string value** of `image_url.url` /
  `document.data` — the content part's `type` and object shape are unchanged, so
  every `part.type` consumer (provider serializers, the `read_skill` scan in
  `tool-dispatch.ts`) is unaffected and JSON round-trips losslessly.
- **Byte-exact.** The original string is stored and restored verbatim (UTF-8),
  keyed by the SHA-256 of those exact bytes. No decode/re-encode/recompress, so
  the model receives identical bytes on resume.
- **Write-before-reference + fsync.** The side file is written atomically
  (temp + fsync + rename) and is durable before the snapshot that references it
  is persisted. A reference can never point at a missing or torn file produced
  by the normal path.
- **Verify-on-read.** Rehydrate re-hashes the loaded bytes and only substitutes
  when the hash matches the reference, so a truncated/corrupt side file is
  rejected rather than fed to the model.
- **Inline fallback.** If externalization fails for any reason (disk full,
  unwritable dir), the payload is left inline and the state write still succeeds.
  The bloat is reintroduced for that one payload, but a task is never stranded.
- **Leave-marker-on-miss + loud refusal.** If a side file is gone or corrupt at
  rehydrate time, the marker string is left in place, and the provider
  serializers (`translateUserContent`, `converseUserContent`,
  `serializeChatContentParts`) **throw** on an unresolved marker rather than
  silently dropping the part. This converts the worst failure mode (a resumed
  turn that quietly loses an image on Anthropic/Bedrock, which otherwise drop
  unparseable parts) into a loud, recoverable error.
- **Unforgeable marker.** The reference prefix begins with a `0x1e`
  (record-separator) control byte, which printable-ASCII base64 payloads can
  never contain, so model/tool output cannot forge or collide with a reference.

## Consequences

- A paused task no longer bloats `state.json` with its image/PDF bytes; the hot
  read path stops paying parse/normalize cost on those payloads.
- Side files are content-addressed and currently never garbage-collected.
  Disk usage under `toolcall-payloads/` grows monotonically with distinct large
  payloads; this is the accepted cost of the no-deletion safety guarantee.
  Removing the instance dir removes them. A future GC pass keyed on live
  `toolCallState` references can reclaim space if needed.
- Snapshot/restore (`harness.ts`) serializes `state` only and does not yet copy
  the side-file directory, so a snapshot restored into an instance whose
  `toolcall-payloads/` was not preserved can carry references whose bytes are
  absent. By the properties above, that surfaces as a loud serializer throw on
  resume of an affected paused task — not a silent image loss. Teaching
  snapshot/restore to include the side-file directory is a follow-up.

## Acceptance checks

- `bun test src/state/toolcall-payloads.test.ts` passes with 100% line +
  function coverage on `src/state/toolcall-payloads.ts`, including byte-exact
  round-trip, threshold gating, content-addressed dedup, the no-mutation
  guarantee, inline fallback on write failure, leave-marker on missing/corrupt
  side file, marker non-forgeability, and the provider-boundary assert.
- `bun run typecheck` passes.
- A real chat turn that pauses for approval with an attached image resumes and
  the model receives the original image bytes.
