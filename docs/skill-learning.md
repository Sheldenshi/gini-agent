# Skill Learning From Skills

Gini gets better at the things it does by **editing its own skills from how tasks
actually turned out**. This page explains the process end to end. The architecture
of record is [Skill Learning From Task Outcomes](adr/skill-learning-from-outcomes.md);
the idea is adapted from SkillOpt (Microsoft, arXiv:2605.23904), which treats a skill
document as the trainable "weights" of a frozen agent.

## The core idea

A skill is a `SKILL.md` file: a short natural-language procedure the agent reads when
it does a task. SkillOpt's insight is that this document can be *trained* — a separate
optimizer proposes small, bounded edits, and an edit is kept only if it passes a gate.
Gini uses the same shape, but the gate and the reward are adapted to a personal agent
that has **no automatic answer key** for open-ended work.

## What counts as a signal (the two-tier reward)

The naive signal — "the user approved the draft" — is not enough. Approving a message
to send only means *the draft looked right*; the send can still fail, or succeed but go
to the wrong person. So Gini learns from the **outcome**, in two tiers:

1. **Objective failure harvesting** — free, continuous, reliable. When a skill's script
   exits with an error, a task ends in `failed`, or an approval is denied, that is an
   unambiguous negative, observed straight from the audit/trace with no human in the
   loop. (Failure is asymmetric: you usually can't *prove* success automatically, but
   failure announces itself.)
2. **Sampled human feedback** — the daily review's targeted ask. Some actions complete
   with no error and were approved, yet may still be wrong ("sent fine — to the wrong
   Sarah"). Gini can't see that in the trace, so it asks you about a few **consequential,
   unverifiable** actions. This fills the gap that approval and error-harvesting both miss.

> Note: a skill's `successCount`/`failureCount` are **not** the signal — those count
> static manifest validation, not whether a run worked.

## Attribution: which skill gets the blame?

A task can load several skills, or none, and the model may ignore a skill's advice — so
"this task failed" doesn't cleanly point at one skill. Gini attributes an outcome to a
skill **only when that skill's script actually ran** (the `skill.script.invoked` audit
row). A skill is only considered for improvement once it has **at least two** attributed
failures, so one weird task never rewrites a skill.

## Classifying the failure: fix the right thing

Not every failure is a skill's fault. Before proposing anything, the reflection
classifies each failure batch:

| Class | Meaning | What Gini does |
|---|---|---|
| `skill_defect` | the skill's procedure was wrong | propose a bounded skill edit |
| `environment` | an external API/service failed | surface a finding (no edit) |
| `credential` | a token/auth problem | surface "reconnect X" (no edit) |
| `model_ignored` | the model didn't follow the skill | flag the trigger as unclear |
| `transient` / `unknown` | one-off noise | ignore |

So an expired Gmail token does **not** cause Gini to rewrite the email skill — it
surfaces a finding suggesting you reconnect.

## The edits, and the gate

When the class is `skill_defect`, the optimizer proposes a few **bounded edits** to the
skill body — `append`, `insert_after`, `replace`, `delete` — never an unconstrained
rewrite, and never instance-specific facts (no names or values, only generalizable
procedure). The edits become an **improvement proposal** you approve or reject:

- **Every edit is human-approved.** Nothing auto-applies — not even for an action you
  already approved. Approving the proposal is the gate.
- **User skills are edited on disk** (the validated write path that rewrites `SKILL.md`
  and reloads). **Bundled skills** (shipped in the repo) are never auto-rewritten — a
  recurring failure there becomes a finding for the developer.
- **Recoverable.** The prior `SKILL.md` body is kept, so a regretted edit reverts in one
  step, and skill version history / rollback still apply.

## The daily review

Once a day (off the agent-turn path, delivered into a dedicated **"Skill review"** chat
session so it never interrupts your main conversation), Gini:

1. batches the recent outcomes and runs the reflection above,
2. posts a short digest: skill-edit proposals to approve, any non-skill findings, and up
   to three targeted feedback questions,
3. records your answers as new outcomes — closing the loop into the same store the next
   review reads.

When you answer a question, the agent calls `record_skill_feedback`, which writes a
user-feedback outcome attributed to the relevant skill, so the human tier and the
objective tier feed one learning store.

## How we know it helped

Without a benchmark answer key, the honest measure is **"did the same failure stop
recurring"** after an edit was applied, together with your answers in the daily review.
It is slow and noisy on purpose — a single user's tasks don't form a clean held-out set.

Each skill also carries a read-only **reliability score** (`GET /api/learning/scores`) — an
*observed-reliability* indicator, not a verdict. It excludes failures that aren't the skill's
fault (a service outage classified `environment` doesn't count), never lets an unverified
side-effecting action read as a confirmed success, and shows **UNRATED** until there's enough
verified signal. It gates nothing — it's there for you to read, not for the system to act on.

## What it does NOT do

The loop *improves* skills that already exist; it never *creates* one. New skills are still
authored on request (ask the agent to "make a skill for X"). Proactively proposing a brand-new
skill from things you do repeatedly is a separate, harder problem and a future step.

## What's intentionally out of scope (for now)

- A web "Skill review" panel (review happens via the API / `gini improvement` CLI / the
  daily digest in v1).
- The full SkillOpt loop with a real held-out verifier — that only fits the narrow band
  of skills that emit **programmatically checkable artifacts** (script/extraction skills).
- A **fleet-offline** regime that pools de-identified, verifier-backed trajectories across
  users to optimize *shipped* skills — where the large, transferable gains actually live,
  with its own consent and privacy design.
