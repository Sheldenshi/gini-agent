---
name: dogfood-as-user
description: How to dogfood and verify a Gini behavior change by driving a real chat turn as a real user would. Use when verifying that the agent reaches for a tool or path on its own — a behavioral steer, a new tool, an INSTRUCTIONS.md change, or a dispatch/provider/memory/skill change — or before claiming a steer "works". Enforces bare, uncoached prompts so the test measures the default, not instruction-following.
---

# Dogfood Gini as a user

When you change agent behavior — a steer in `INSTRUCTIONS.md`, a tool, dispatch, providers, memory, or skill wiring — the only real test is a **real chat turn driven as a real user**. Unit tests verify the mechanism; the chat turn verifies the model actually reaches for it.

## The one rule: bare, uncoached prompts

Send exactly what a real user would type — and nothing more. Never narrate the intended behavior into the message.

- ✅ `Buy me a one-day fishing license day pass for California.`
- ❌ `Buy me a fishing license. Drive the purchase as far as you can in the browser before involving me.`
- ❌ `... use your handoff flow` / `... ask me with a choice card` / `... do as much as possible without me`

A coached prompt tests instruction-following, not the default the change is meant to install — and it routinely makes a behavior look more robust than it is, even producing a structured affordance (e.g. an `ask_user` choice card) that the bare prompt never triggers. The behavior belongs in `INSTRUCTIONS.md`, never in the user's mouth.

Proven here: the same task, coached ("drive as far as you can before involving me"), produced an `ask_user` card and a browser handoff; the **bare** prompt only described the options in prose and ended the turn. The coaching masked a real gap. Always send the bare request, then judge whether the agent gets there on its own.

## Procedure

1. **Instance** — use the worktree's own instance (the basename of the workspace dir), never `default`.
2. **Gateway up** — `tmux new-session -d -A -s gini-<instance> "bun run gini run --instance <instance>"`; confirm with `gini status --instance <instance>` (look for `"ok": true`).
3. **Fresh session** — create a new chat/agent so no earlier coaching is sitting in context.
4. **Send the bare request** through the surface you're testing — the web app (so `clientSurface` is `web`), `gini chat send <session> "<prompt>"`, or mobile. One message, no scaffolding.
5. **Observe** — poll the task's `recentToolCalls`, tail `~/.gini/instances/<instance>/logs/runtime.jsonl`, or watch the web UI. Judge whether the agent reaches the intended behavior / selects the right tool / emits the right structured affordance **unprompted**.
6. **Judge honestly** — success is getting there on its own. If it only gets there when coached, that's a FAIL of the change, not a pass — say so plainly and quote what it actually did.

## Safety when the flow transacts

Don't complete real purchases or enter real (or fake) PII/payment into real sites. To reach a payment/secret fork safely, drive a benign mock — e.g. `demoblaze.com`, a demo store whose "Place Order" modal has a credit-card field and never charges — and **stop before submitting**. Loopback/`localhost` is blocked for the agent's browser, so you can't self-host a mock it can reach; use a public safe target.

## After

Clean up throwaway test agents/sessions and any parked approvals; disconnect any visible Chrome with `gini browser disconnect --instance <instance>`.

## Provider caveat

Steer adherence is model-dependent. Verify on the model the change actually targets, and name the provider in your report (a pass on one model is not a pass on another).
