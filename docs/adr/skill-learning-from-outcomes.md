# Skill Learning From Task Outcomes

## Decision

Gini improves its own skills by treating each **user skill's `SKILL.md` body as an
editable artifact trained from TASK OUTCOMES** — the way the agent actually fared
when it used the skill — rather than from a human approving a draft. The shape is
borrowed from SkillOpt (Microsoft, arXiv:2605.23904, *"Executive Strategy for
Self-Evolving Agent Skills"*): a skill document is the trainable text, a separate
optimizer pass proposes **bounded `append`/`insert_after`/`replace`/`delete` edits**,
and an edit is only ever applied through a gate. SkillOpt's gate is an automatic
held-out verifier; Gini's open-ended personal-assistant work has no such verifier,
so the design adapts the gate and the reward signal to what a single-user runtime
actually has, and **reuses existing primitives** instead of adding a parallel stack:
`ImprovementProposal` (the propose → approve/reject → apply governance path),
`SkillRecord` versioning + `rollbackSkill`, `generateStructured` (the same structured
LLM call Hindsight memory uses), the `skill.script.invoked` audit row, and the
scheduler.

Six choices define the system (each is the resolution of an open design question;
see [Skill Learning From Skills](../skill-learning.md) for the narrative):

1. **Two-tier reward — outcomes, not approvals.** Human approval of an action signals
   only that the *draft looked right*; the action can still fail in execution (the send
   throws) or be silently wrong (sent to the wrong person). So the reward is the
   **outcome**, captured in two tiers:
   - **Objective failure harvesting** (continuous, free, high-confidence-negative):
     a skill's script exited non-zero / produced no JSON, the task ended `failed`,
     an approval was denied, the agent thrashed. These are read from already-persisted
     audit + trace and need no human.
   - **Sampled human feedback** (the daily review's targeted ask): for actions that
     completed *without* an objective error but were *consequential and unverifiable*,
     Gini asks the user — the only entity that can adjudicate "looked fine, but was it
     right?" This fills the silent-wrong gap that approval and error-harvesting both
     miss.
   `SkillRecord.successCount`/`failureCount` are deliberately **NOT** the reward — they
   are bumped only by `testSkill()` static manifest validation (`src/capabilities/skills.ts`),
   uncorrelated with whether a run worked.

2. **The daily review IS the cadence and the ask.** An offline pass runs on a slow
   schedule (default daily), batches recent outcomes, proposes edits, and delivers a
   **digest** into a dedicated "Skill review" chat session — never the user's main chat
   (avoids the job-into-main-chat interleave hazard). The digest is targeted, not
   "how was your day": at most a few skill-edit proposals to approve, any non-skill
   findings, and at most 3 feedback questions about consequential/unverifiable actions.

3. **Attribution via the skill script.** A task may load several skills or none and the
   model is free to ignore a skill, so "the task failed" doesn't cleanly blame a skill.
   v1 attributes an outcome to a skill **only when that skill's script ran** — the
   `skill.script.invoked` audit row (`target: skill.id`, evidence `{ skill, script, ok,
   exitCode }`) is the clean per-skill signal. A skill is only optimized when it has
   **≥ 2 attributed failures** (cross-trajectory support, an anti-overfit floor).
   Task-level failures with no script attribution are recorded for the digest's
   "what didn't work" summary but never drive a skill edit.

4. **Defect classification routes the fix.** A failed send might be a skill defect, a
   flaky API, an expired token, or the model ignoring the skill — and only the first
   warrants a skill edit. The reflection's structured LLM call classifies each failure
   batch as `skill_defect | environment | credential | model_ignored | transient |
   unknown`. `skill_defect` → a bounded skill-edit proposal; `environment` / `credential`
   → a **LearningFinding** surfaced in the digest (e.g. "your Gmail token keeps expiring
   — reconnect?"), **not** a skill edit; `model_ignored` → a finding flagging trigger
   clarity; `transient` / `unknown` → dropped.

5. **General plumbing, skills first.** The proposal mechanism stays general
   (`ImprovementProposal` already spans `skill | job`; findings cover connector/infra
   issues), but v1 ships **skill-edit proposals** and surfaces non-skill findings;
   it does not auto-create jobs or rewrite memory.

6. **The edit is always human-gated; bundled skills are read-only.** Every skill edit
   flows through `reviewImprovement` (`actor:"user"` approve/reject, audited) — nothing
   auto-applies, regardless of the underlying action's approval, and a permission-bearing
   skill is never auto-edited. Edits target **user skills only** (`source:"user"`, an
   on-disk `SKILL.md` under the instance): apply rewrites that file through the validated
   `installSkillFromBody` path and reloads. **Bundled** skills (vendored under the repo's
   `skills/`) are never rewritten on disk — a recurring failure there becomes a finding
   that points the developer at the repo. Approval stores the prior `SKILL.md` body on the
   proposal so a regret is one revert away, complementing `rollbackSkill`.

## Context

The motivating research is SkillOpt, which formulates skill improvement as text-space
optimization: the skill is the parameter, a trajectory-derived edit is the gradient, an
edit budget is the learning rate, and a held-out validation gate accepts an edit only when
it strictly improves a held-out score. Its results are strong (best-or-tied on all 52
model × benchmark × harness cells, +23.5 average over no-skill in direct chat), and its
own ablations show the gains come from a **median of 2.5 accepted edits** with most
proposals rejected — i.e. the **gate** does the discriminative work. SkillOpt §B is
explicit that the loop relies on automatic verifiers and a held-out split, and that
"open-ended domains where success is subjective" need "stronger human or model-based
evaluation."

Gini's core is exactly that open-ended domain. A naive port that swaps the verifier for
an LLM-judge auto-gate would be a *self-consistency* check (proposer and judge share the
same priors) that ratifies drift rather than rejecting it — and it would edit skills that
carry connector grants and emit side-effecting scripts. So this ADR keeps the human as the
**authorizing gate**, leans on the **objective failure** signal (which Gini *can* observe
without a verifier), and uses sampled human feedback for the unverifiable remainder. The
honest contribution is "SkillOpt proposes, the human approves," which is the existing
`ImprovementProposal` loop with one thing added: proposals are now **auto-generated from
outcome evidence** instead of only user-initiated.

The full-fidelity SkillOpt (batch rollouts + a real held-out verifier + replay-based
gate) legitimately applies only to the narrow band of Gini skills that emit
**programmatically-checkable artifacts** (script-emitting / schema-extraction skills), and
the personalization-scale result lives in a future **fleet-offline** regime (pooled,
de-identified, verifier-backed trajectories optimizing *shipped* skills). Both are out of
scope here and tracked under Limitations.

This composes with: [Job Skill Attachments](job-skill-attachments.md) (skills as the unit
of procedural memory), [Per-Agent Memory Isolation](agent-memory-isolation.md) (the
Hindsight reflect/reinforce loop this mirrors), [Pre-LLM Job Hooks](job-pre-run-hooks.md)
and [Email Watch](email-watch.md) (the offline-pass + scheduler host pattern),
[Per-Skill Connector Consent Grant](skill-connector-consent.md) and
[Declarative Approval Gating For Skill Scripts](skill-script-approval-gating.md) (the
safety boundary edits must preserve).

## Required Now

- **`SkillOutcome`** on `RuntimeState.skillOutcomes` (bounded ring, newest-first), one row
  per attributable run outcome:
  `{ id, instance, taskId, agentId?, skillId?, skillName?, scriptName?, signal:"success"|"failure",
  source:"objective"|"user_feedback", exitCode?, errorDetail?(redacted, capped), consequential:boolean,
  selfVerifiable:boolean, defectClass?, reviewed:boolean, feedbackPrompted:boolean, createdAt }`.
  `consequential` is true when the attributed skill declares `requiredPermissions` or the
  task carried an approval/side-effecting audit row; `selfVerifiable` is true when an
  objective signal existed (a script ok/exit, a terminal status). CRUD in
  `src/state/records.ts`; all writes via `mutateState`. `normalizeState` defaults the array
  to `[]` so older state files load.

- **Objective extraction** (`src/learning/outcomes.ts`): `recordObjectiveOutcomes(config, task)`
  is called fire-and-forget at task terminal alongside `scheduleAutoRetain` (`src/agent.ts`).
  It reads the task's already-persisted `skill.script.invoked` audit rows + `task.status` and
  writes one `SkillOutcome` per script invocation (`failure` when `ok:false`/non-zero exit,
  else `success`), attributed by `target`/evidence. A `failed` task with no script invocation
  yields one unattributed (`skillId` unset) failure row for the digest only. Error text is
  scrubbed and truncated. It only reads + appends a bounded array, so it adds negligible
  terminal-path cost and never throws into the task.

- **Edit contract** (`src/learning/edits.ts`): `SkillEditOp =
  { op:"append", content } | { op:"insert_after", anchor, content } | { op:"replace", target, content }
  | { op:"delete", target }`, and a pure `applySkillEdits(body, ops): { body, applied, skipped[] }`
  that operates on the markdown body, matches `anchor`/`target` as exact substrings, and
  **skips (records) rather than throws** on a no-match. Unit-tested per op.

- **Reflection / optimizer** (`src/learning/reflect.ts`): `reflectOnSkillOutcomes(config, { agentId?, maxProposals=2 })`
  gathers unreviewed failure outcomes, groups by `skillId`, and for each skill with **≥ 2**
  unreviewed failures makes one `generateStructured` call (provider resolved from the agent,
  like reinforce) returning `{ defectClass, attributable, edits: SkillEditOp[], rationale,
  nonSkillFinding? }`. Routing: `skill_defect` + a **user** skill + non-empty edits → create an
  `ImprovementProposal` (below); `environment`/`credential`/`model_ignored` → a `LearningFinding`;
  a `skill_defect` on a **bundled** skill → a finding (no disk edit). All processed outcomes are
  marked `reviewed:true`. Proposals are clipped to `maxProposals` (SkillOpt's edit-budget floor
  of 2). The prompt forbids instance-specific edits (names, values) — only generalizable procedure.

- **Proposal payload (edit mode).** A skill-edit proposal reuses `ImprovementProposal`
  (`kind:"skill"`) with `payload = { mode:"edit", targetSkillId, baseVersion, baseBody, edits:
  SkillEditOp[], candidateBody }`. `applyImprovement` (`src/governance/improvements.ts`) gains an
  edit branch: when `payload.mode === "edit"`, resolve the target skill; refuse if it is not a
  `source:"user"` skill with a `manifestPath` (bundled/legacy → throw, surfaced to the reviewer);
  otherwise rebuild the full `SKILL.md` from the current file, apply the edits to its body, and
  write through `installSkillFromBody` (validated write + reload). `baseBody` enables a one-call
  revert. The existing create branch is unchanged. `normalizeImprovementPayload` preserves the
  edit fields.

- **`LearningFinding`** on `RuntimeState.learningFindings` (bounded): `{ id, instance, agentId?,
  skillId?, skillName?, kind:"environment"|"credential"|"model_ignored"|"bundled_skill", summary,
  sourceTaskIds[], status:"open"|"dismissed", createdAt }`. Surfaced in the digest and via a
  read-only endpoint; never auto-actioned.

- **Daily review** (`src/learning/daily-review.ts`): `runDailyReview(config)` calls
  `reflectOnSkillOutcomes`, selects up to 3 **feedback candidates** (recent `success` outcomes that
  are `consequential && !feedbackPrompted`, marked `feedbackPrompted:true`), assembles a digest
  (proposals awaiting approval + open findings + the targeted questions), and posts it as a message
  into a dedicated, auto-provisioned **"Skill review"** chat session (a `channel`-kind session with a
  stable feature marker, created once). Hosted by a slow, abortable loop in `src/server.ts`
  modeled on the connector-reprobe loop (default 24h, `GINI_SKILL_REVIEW_TICK_MS` override; runs DB
  writes off the agent-turn path), plus a manual `POST /api/learning/review` for testing. The loop
  participates in the existing SIGTERM drain.

- **Feedback capture** (`record_skill_feedback` agent tool, low-risk): when the user answers a
  review question, the agent records the verdict as a `SkillOutcome` with `source:"user_feedback"`
  (a negative answer → `signal:"failure"` attributed to the named skill/task), closing the second
  tier of the loop into the same store the next review reads. Registered in the tool catalog +
  dispatch.

- **Read surfaces.** `GET /api/learning/outcomes`, `GET /api/learning/findings`, and the existing
  `GET /api/improvements` (+ `gini improvement` CLI) are the review surfaces for v1. A dedicated web
  "Skill review" panel is a fast-follow (the backend `useImprovements()` query already exists with
  no renderer).

## Trust Boundary

- **The optimizer reads trajectory evidence** (error text, tool/skill names) and calls an LLM.
  Error detail is **scrubbed and truncated** at capture (`recordObjectiveOutcomes`), reusing the
  redaction posture of traces; the reflection prompt receives skill bodies + scrubbed failure
  summaries, never raw message bodies. This stays within the local instance — no fleet/cross-user
  pooling in v1 (that regime, with its own consent + de-identification, is out of scope).

- **Edits never bypass governance.** Reflection only *proposes*; `reviewImprovement`'s human
  approve/reject is the apply gate, and it emits the existing `improvement.applied` /
  `improvement.rejected` audit rows. A permission-bearing or side-effecting skill is edited only on
  explicit human approval, exactly like any other improvement; nothing auto-applies. Bundled skills
  are never written to disk by the optimizer.

- **Recoverability.** An applied edit goes through `installSkillFromBody` (which bumps the skill
  version on reload) and stores `baseBody`, so a bad edit is reverted by re-installing `baseBody`;
  `rollbackSkill` remains available as the version-history undo. The optimizer loop is abortable and
  drains on shutdown like the other server loops.

- **Containment unchanged.** The optimizer adds no new credential access and runs no skill scripts;
  it only reads audit/trace and writes proposals/findings. Skill-script execution, approval gating,
  and connector consent (`skill-connector-consent.md`, `skill-script-approval-gating.md`,
  `skill-env-containment.md`) are untouched.

## Limitations & Open Questions

- **No automatic verifier for open-ended work.** The objective tier captures *failure* reliably but
  cannot confirm *success*; the human tier samples but cannot cover everything. v1 measures whether
  an applied edit helped by **"did the same failure stop recurring"** over subsequent runs (plus the
  daily answers) — slow and noisy by construction, not a held-out score.

- **Thin single-user data.** A single user generates sparse, heterogeneous, non-repeating tasks, so
  the ≥2-failure floor and the procedural-only constraint are anti-overfit guards, not a substitute
  for SkillOpt's batch statistics. Per-user optimization is intentionally conservative.

- **Bundled skills are propose-only.** Recurring failures in a vendored skill surface as findings
  for the developer, not auto-edits; landing those as repo PRs (or as user-instance overrides) is a
  future option.

- **Reply → outcome wiring** depends on the agent calling `record_skill_feedback` when the user
  answers; a structured "answer this review question" affordance (instead of free-text) is a
  follow-up.

- **Web review panel** and a **fleet-offline, verifier-backed** SkillOpt for checkable-artifact
  skills are the two larger follow-ups; both are deliberately out of v1.

## Verification

- `bun test src/learning/edits.test.ts` — each edit op against a sample `SKILL.md` body
  (append/insert_after/replace/delete; no-match is skipped + recorded, never thrown).
- `bun test src/learning/outcomes.test.ts` — extraction from synthetic `skill.script.invoked` audit
  rows + task status: a non-zero exit yields an attributed `failure`, an `ok` invocation a `success`,
  a script-less `failed` task an unattributed failure row; error text is scrubbed.
- `bun test src/learning/reflect.test.ts` (echo provider) — a skill with ≥2 failures produces a
  bounded edit proposal; a bundled skill produces a finding not a disk edit; `environment`/`credential`
  verdicts produce findings; the ≥2 floor and `maxProposals` clip hold; instance-specific edits are
  refused.
- `bun test src/state` — `SkillOutcome` / `LearningFinding` CRUD + `normalizeState` defaults; the
  `applyImprovement` edit branch (user-skill body rewritten via `installSkillFromBody`; bundled
  target rejected; `baseBody` stored).
- `bun run typecheck && bun run test && bun run gini smoke`.
- **Dogfood (the real surface).** On the worktree's instance, run a chat turn that invokes a skill
  whose script fails, confirm a `SkillOutcome` failure row is attributed, trigger `runDailyReview`
  (or `POST /api/learning/review`), and confirm a bounded `ImprovementProposal` (or finding) appears
  with the diff + rationale + evidence, approve it through `reviewImprovement`, and confirm the user
  skill's `SKILL.md` body changed and reverts cleanly.
