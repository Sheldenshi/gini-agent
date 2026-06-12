# ADR: Declarative approval gating for skill scripts

## Decision

A skill can declare, in its SKILL.md frontmatter, that specific scripts must never run without an explicit user Approve/Deny:

```yaml
metadata:
  gini:
    requires:
      approval: [place-call]
```

The loader parses `metadata.gini.requires.approval` (a list of script names — the `script` argument of `skill_run`) into `SkillRecord.requiresApprovalScripts`. When the model calls `skill_run` on a listed script, dispatch creates a pending `Authorization` with the new action `"skill.run"` and pauses the task — **regardless of approval mode**. `auto` and `yolo` do not bypass the gate; like `browser_connect`, the dispatch path skips `pendingOrAuto` entirely and always returns the pending approval. On approve, the executor re-resolves the script handle (the skill may have been disabled since the pause), runs it with the persisted args, audits a `skill.run` row joined to the approval, and resumes the chat task. On deny, the standard denial path fails the task.

The approval row's `reason` carries a compact preview of the script args (truncated around 400 characters) for the Permissions surface and the audit trail; the inline chat card itself stays minimal (a "Confirm <Skill Name>" title with Confirm/Deny — the agent's announce message above it carries the context), and the full args live on `payload.scriptArgs`.

## Context

The first consumer is the phone-call skill: placing an outbound call is outward-facing and irreversible, and free-text chat confirmation ("should I go ahead?" → "yes") proved unreliable — models re-confirm unpredictably and typed confirmations are clunky. The runtime already has the right primitive: the Authorization gate, rendered in the chat thread as an inline Approve/Deny card (`authorization_requested` chat block). This ADR makes that gate declaratively reachable from skill frontmatter instead of special-casing any one skill — model-callable scripts can now demand human consent as data, which is a trust-boundary extension: the set of always-gated actions is no longer fixed in dispatch code.

## Scope of the gate

The gate lives in the `skill_run` dispatch path **only**, never in `invokeSkillScript`. Internal callers of `invokeSkillScript` are deliberately unaffected:

- the skill-script pre-run hook handler (`skill-script-hook.ts`, see ADR [job-pre-run-hooks.md](job-pre-run-hooks.md)) — watcher hooks like `phone-call/call-watch` must keep polling headless;
- the approved-action executor itself, which would otherwise gate the script a second time after the user already approved it.

## Consequences

- Skill authors mark a script as gated by adding its name to `requires.approval`; no runtime code changes per skill.
- A gated script's approval card renders inline in the chat (the existing `authorization_requested` block); the Permissions surface lists it like any other pending Authorization.
- The model contract for gated scripts changes from "confirm in chat, then run" to "announce in one message, then call the script immediately — the card is the confirmation" (see the phone-call SKILL.md).
- Unknown script names in the list are harmless: gating is checked against the resolved script handle at dispatch time, so a stale entry simply never matches.
- If a future skill needs per-args gating (e.g. only gate calls to new numbers), that is a policy-engine concern and stays out of this declarative mechanism.

## Acceptance checks

- A `skill_run` call on a script listed in `requiresApprovalScripts` pauses the task `waiting_approval` under `strict`, `auto`, and `yolo` alike, with action `skill.run`, target `<skill>/<script>`, and an args preview in the reason.
- Approving runs the script, writes a `skill.run` audit row with the approval id, and resumes the task; denying fails the task without running the script.
- Approving after the skill was disabled returns a clean `{ ok: false }` tool result instead of executing.
- Scripts not listed run synchronously with no Authorization row.
- Pre-run hook execution of the same skill's scripts never creates an Authorization.

## Related

- [approval-and-audit-substrate.md](approval-and-audit-substrate.md)
- [approval-mode.md](approval-mode.md)
- [authorization-vs-setup-request.md](authorization-vs-setup-request.md)
- [job-pre-run-hooks.md](job-pre-run-hooks.md)
