// Periodic sweep that auto-cancels abandoned setup requests.
//
// Nothing else expires a pending `state.setupRequests`: once raised, a
// request sits until the user resolves it, so a genuinely-abandoned one
// keeps its owning task in `waiting_approval` forever. This pass reaps
// requests older than a TTL via the existing resolution contract, so the
// task either resumes (connector.request / chat.choice /
// confirmation.request decline) or fails (fill_secret / login) per its
// action type.
//
// Intentionally separate from the job scheduler: like the connector
// re-probe, it doesn't claim an instance lock and doesn't run a Task. It
// is a maintenance pass the runtime owns directly.

import type { RuntimeConfig } from "../types";
import { appendLog, readState } from "../state";
import { ApprovalRaceLostError, resolveSetupRequest } from "../agent";

// 24h default: long enough that a user answering a prompt later the same
// day still works; the queue-guard fix already covers the live-reply case,
// so this only reaps truly-abandoned requests. Tunable via env, but a
// non-finite or non-positive override falls back to the default rather than
// poisoning the age comparison (a NaN TTL would sweep every pending request).
const envTtl = Number(process.env.GINI_SETUP_REQUEST_TTL_MS);
export const SETUP_REQUEST_TTL_MS = Number.isFinite(envTtl) && envTtl > 0 ? envTtl : 24 * 60 * 60 * 1000;

export async function runSetupRequestSweep(
  config: RuntimeConfig
): Promise<{ considered: number; expired: string[] }> {
  const state = readState(config.instance);
  const expired: string[] = [];
  let considered = 0;
  const at = Date.now();

  for (const item of state.setupRequests) {
    if (item.status !== "pending") continue;
    considered += 1;
    // An unparseable createdAt yields NaN; treat a non-finite age as
    // not-yet-expired so a corrupt timestamp is never swept.
    const age = at - Date.parse(item.createdAt);
    if (!Number.isFinite(age) || age <= SETUP_REQUEST_TTL_MS) continue;
    try {
      // Match the HTTP cancel contract (awaitResume:false) so the sweep never
      // runs a full agent loop inline — the connector/choice/confirmation
      // resume fires in the background.
      await resolveSetupRequest(config, item.id, "cancel", { actor: "runtime", awaitResume: false });
      expired.push(item.id);
    } catch (error) {
      // The request was resolved between our read and the call — another
      // caller won the race. Swallow it; for any other error, log and keep
      // going so one bad item never truncates the rest of the pass.
      if (error instanceof ApprovalRaceLostError) continue;
      appendLog(config.instance, "setup-request.sweep.item_error", {
        id: item.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (expired.length > 0) {
    appendLog(config.instance, "setup-request.swept", { expired });
  }

  return { considered, expired };
}
