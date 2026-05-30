// Restart-ask glue for the consent-based crash-reporting flow.
//
// On gateway boot (called best-effort from src/server.ts), this checks the
// pending/ crash queue and, for the `default` launchd instance only, posts ONE
// friendly chat message asking the user whether to file the captured crashes as
// GitHub issues. The actual filing happens later, when the user replies, via
// the gini-bug-report skill — this module only asks.
//
// Guardrails:
//   - Gated to instance==="default" && under launchd. Throwaway/conductor
//     instances never ask.
//   - One question per DISTINCT fingerprint, ask-once within a 24h window
//     (lastAskedAt), so a crash loop or a respawn doesn't re-ask. The stamp is
//     written BEFORE the ask is created so a crash mid-ask can't double-ask.
//   - Multiple pending crashes are batched into a SINGLE ask.
//   - Everything is wrapped in try/catch -> appendLog; this never throws, so it
//     can't block or crash boot.

import type { RuntimeConfig } from "../types";
import { supervisor } from "../integrations/launchd";
import { createScheduledJob } from "../jobs";
import { appendLog } from "../state/trace";
import {
  listPendingReports,
  markAsked,
  wasAskedRecently,
  type CrashReport
} from "./crash-report";

// Ask-once window: don't re-surface the same fingerprint within 24h.
const ASK_WINDOW_MS = 24 * 60 * 60 * 1000;

// The prompt the seeded one-shot job runs. It instructs the agent to post a
// single chat message asking for consent — and explicitly NOT to file or act
// this turn. When the user replies, the gini-bug-report skill does the work.
//
// The SPECIFIC fingerprints being asked about are named in FULL so the consent
// is bound to exactly this batch: a crash that lands between the ask and the
// user's "yes" must not get filed under this consent. The skill matches each
// pending report against these full fingerprints EXACTLY — an 8-char prefix
// could misattribute a later same-prefix crash to this consent.
export function ASK_PROMPT(fingerprints: string[]): string {
  const count = fingerprints.length;
  const noun = count === 1 ? "crash" : "crashes";
  // Full fingerprints so the skill can match exactly; a short form is shown to
  // the user as cosmetic sugar only, never used for the file/dedup decision.
  const fullList = fingerprints.join(", ");
  return [
    `Gini detected ${count} ${noun} since it last ran (captured locally and already redacted — no secrets or message content).`,
    "",
    `The specific crash fingerprint(s) this consent covers (match these EXACTLY): ${fullList}.`,
    "",
    "In ONE short, friendly chat message: tell the user you noticed the " +
      `${count} ${noun}, and ASK whether they'd like you to file ${count === 1 ? "it" : "them"} as ` +
      "GitHub issue(s) to help improve Gini.",
    "",
    "Do NOT file anything and do NOT take any other action this turn — just ask the question and wait for the user's answer.",
    "When the user replies, use the gini-bug-report skill to act on their answer — and file ONLY the " +
      `fingerprint(s) named above (matched EXACTLY: ${fullList}), not any other crash that may have landed since.`
  ].join("\n");
}

export interface MaybeAskDeps {
  // The return value is intentionally ignored — the ask glue never reads the
  // created JobRecord — so the seam is typed to swallow any result, letting a
  // test recorder return a stub without satisfying the full JobRecord shape.
  createJobImpl?: (config: RuntimeConfig, input: Record<string, unknown>) => Promise<unknown>;
  supervisorImpl?: () => "launchd" | null;
  clock?: () => Date;
  listPendingImpl?: () => Array<{ path: string; report: CrashReport }>;
  markAskedImpl?: (fingerprint: string, atIso: string) => void;
  wasAskedRecentlyImpl?: (fingerprint: string, nowMs: number, windowMs: number) => boolean;
}

export async function maybeAskAboutCrashes(
  config: RuntimeConfig,
  deps: MaybeAskDeps = {}
): Promise<void> {
  const createJobImpl = deps.createJobImpl ?? createScheduledJob;
  const supervisorImpl = deps.supervisorImpl ?? supervisor;
  const clock = deps.clock ?? (() => new Date());
  const listPendingImpl = deps.listPendingImpl ?? listPendingReports;
  const markAskedImpl = deps.markAskedImpl ?? markAsked;
  const wasAskedRecentlyImpl = deps.wasAskedRecentlyImpl ?? wasAskedRecently;

  try {
    // Only the default, launchd-supervised instance asks. Everything else
    // (conductor/tmux/throwaway) captures but never bothers the user.
    if (config.instance !== "default" || supervisorImpl() !== "launchd") return;

    // Defensive: only consider reports that belong to this instance.
    const reports = listPendingImpl().filter((r) => r.report.instance === config.instance);
    if (reports.length === 0) return;

    const nowMs = clock().getTime();
    const nowIso = clock().toISOString();

    // Distinct fingerprints we haven't already asked about within the window.
    const freshFingerprints: string[] = [];
    for (const { report } of reports) {
      const fp = report.fingerprint;
      if (!fp) continue;
      if (freshFingerprints.includes(fp)) continue;
      if (wasAskedRecentlyImpl(fp, nowMs, ASK_WINDOW_MS)) continue;
      freshFingerprints.push(fp);
    }
    if (freshFingerprints.length === 0) return;

    // Stamp lastAskedAt BEFORE creating the job so a crash that respawns the
    // gateway mid-ask can't produce a second question for the same crash.
    for (const fp of freshFingerprints) {
      markAskedImpl(fp, nowIso);
    }

    await createJobImpl(config, {
      name: "crash-report-consent",
      prompt: ASK_PROMPT(freshFingerprints),
      intervalSeconds: 2,
      oneShot: true,
      timeoutSeconds: 120,
      createDedicatedSession: { title: "Crash report" }
    });
  } catch (err) {
    appendLog(config.instance, "crash.recovery.error", { error: String(err) });
  }
}
