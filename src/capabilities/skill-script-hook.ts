// Generic `skill-script` hook handler (ADR job-pre-run-hooks.md).
//
// A single DOMAIN-AGNOSTIC hook handler that runs ANY named skill script
// HEADLESS (no agent turn, no approval) and maps its stdout onto the typed hook
// result. It is the bridge between two core primitives — the hooks registry and
// the skill-script runner — so it lives in src/capabilities beside skill-scripts.ts
// (both core, neither a domain) and self-registers into the hooks registry via
// src/hooks/builtins.ts. The generic hook primitive (src/hooks/{types,registry,
// runner,index}) stays a pure leaf and never imports this.
//
// State model: the script is a PURE function. It receives {...declarativeConfig,
// state} on stdin and emits {kind, items?, summary?, state} on stdout — it MUST
// NOT touch files/DB. This handler is the conduit: the current state arrives in
// hookConfig.state (the jobs consumer passes job.hookState as the runHook
// payload), is forwarded to the script, and the script's new state rides back on
// the HookResult. The CONSUMER persists newState at the J4-correct moment
// (shortCircuit immediately; context only after the turn dispatches).
//
// Error taxonomy follows the hook contract so a scheduled job survives a
// transient stall:
//   - missing/unknown skill | script, missing skill/script config key, or a
//     malformed script result => { kind: "error" } (CONFIG, fatal to a schedule).
//   - non-zero exit / unparseable stdout / a script throw => mapped to a hook
//     `error` whose message marks it transient... but the hook `error` kind has
//     no transient flag, and the runner classes a handler-returned error as
//     non-transient (config). To keep a scheduled job ALIVE across a transient
//     script failure (per J2), this handler THROWS on a transient failure so the
//     runner's catch classes it transient — the same shape gmail's old transport
//     errors used to stay alive.

import type { HookContext, HookContextItem, HookResult } from "../hooks/types";
import { registerHook } from "../hooks/registry";
import { readState } from "../state";
import { findSkillScript, invokeSkillScript } from "./skill-scripts";

// Per-script wall-clock budget. Tighter than a job's 600s timeout because the
// hook is on the critical path to the model turn; the runner's per-hook timeout
// still bounds the whole hook, this just bounds the child so a wedged script is
// killed and surfaced as a transient failure rather than waiting on the outer
// race.
const SCRIPT_TIMEOUT_MS = 20_000;

// A skill-script hook result, as the script emits it on stdout. `items` carry
// raw untrusted external content (the runner fences them); `summary` is the
// shortCircuit run summary; `state` is the script's opaque next state.
interface SkillScriptOutput {
  kind: "shortCircuit" | "context";
  items?: HookContextItem[];
  summary?: string;
  state?: Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Validate the parsed stdout into a typed HookResult, or return a config-error
// message string when the shape is malformed (so a buggy script takes the typed
// fatal path, never a throw past the consumer). Returns a discriminated result
// so the caller can tell a valid parse from a shape error.
function toHookResult(parsed: unknown): { ok: true; result: HookResult } | { ok: false; error: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "skill-script: script output was not a JSON object" };
  }
  const out = parsed as Partial<SkillScriptOutput>;
  const state = out.state && typeof out.state === "object" && !Array.isArray(out.state)
    ? (out.state as Record<string, unknown>)
    : undefined;

  if (out.kind === "shortCircuit") {
    return {
      ok: true,
      result: {
        kind: "shortCircuit",
        ...(typeof out.summary === "string" ? { summary: out.summary } : {}),
        ...(state !== undefined ? { state } : {})
      }
    };
  }

  if (out.kind === "context") {
    if (!Array.isArray(out.items)) {
      return { ok: false, error: "skill-script: context result is missing an items array" };
    }
    const items: HookContextItem[] = [];
    for (const item of out.items) {
      if (!item || typeof item !== "object" || typeof (item as { text?: unknown }).text !== "string") {
        return { ok: false, error: "skill-script: context item must be { text, untrusted }" };
      }
      const it = item as { text: string; untrusted?: unknown };
      items.push({ text: it.text, untrusted: it.untrusted === true });
    }
    return {
      ok: true,
      result: {
        kind: "context",
        items,
        ...(state !== undefined ? { state } : {})
      }
    };
  }

  return { ok: false, error: `skill-script: unknown result kind: ${String(out.kind)}` };
}

export async function skillScriptHandler(ctx: HookContext): Promise<HookResult> {
  const { config, hookConfig } = ctx;
  const skill = asString(hookConfig.skill);
  const script = asString(hookConfig.script);
  // Missing skill/script names are a CONFIG error — a draft is meaningless and
  // retrying never resolves it.
  if (!skill) return { kind: "error", message: "skill-script: missing `skill` in hook config" };
  if (!script) return { kind: "error", message: "skill-script: missing `script` in hook config" };

  const handle = findSkillScript(readState(config.instance), skill, script);
  if (!handle) {
    return { kind: "error", message: `skill-script: no enabled skill "${skill}" with script "${script}"` };
  }

  // Args = the declarative config (everything except the routing keys) + the
  // current opaque state forwarded from the consumer's payload. The script is a
  // pure function of these; it never persists state itself.
  const { skill: _s, script: _sc, state, ...declarative } = hookConfig;
  const args = { ...declarative, state: state ?? null };

  const result = await invokeSkillScript(config, handle, args, { timeoutMs: SCRIPT_TIMEOUT_MS });
  if (!result.ok) {
    // Non-zero exit / unparseable stdout / timeout / script throw. Throw so the
    // runner classes it TRANSIENT — a scheduled job must stay active and retry
    // next tick rather than be deactivated by a transient script fault (J2).
    throw new Error(result.error ?? "skill-script: script failed");
  }

  const mapped = toHookResult(result.parsed);
  // A malformed (but successfully-parsed-as-JSON) result is a CONFIG error: the
  // script is misbehaving and a draft is meaningless. The runner classes a
  // handler-returned `error` as non-transient (fatal to a schedule).
  if (!mapped.ok) return { kind: "error", message: mapped.error };
  return mapped.result;
}

// Self-register into the trusted hooks registry as a load side-effect. Reached
// at composition time via src/hooks/builtins.ts.
registerHook("skill-script", skillScriptHandler);
