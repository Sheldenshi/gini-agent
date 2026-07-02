import type { ChatSession } from "./view-types";

// Is this session a recurring-job CHANNEL the user can open from a list?
//
// A job channel is `kind:"channel"` OR `origin:"job"` — the same
// disjunction the gateway (`unreachableSessionIds` in src/http.ts) and the
// mobile client (`useChannels` in mobile/src/queries.ts) use. `normalizeState`
// backfills `kind:"channel"` onto `origin:"job"` sessions on load, so the two
// arms usually coincide on persisted state; keeping the `origin` arm matches
// the other surfaces defensively, so a not-yet-normalized `origin:"job"`
// channel still appears on the rail. That alignment matters because the badge
// counts a session it deems reachable: if web hid an `origin:"job"` channel
// the gateway still counted, the badge would show a number with no row to
// open and clear.
//
// Archived sessions are excluded: they keep their history and stay addressable
// by URL but leave the lists (and the badge accounting).
export function isOpenableJobChannel(session: ChatSession | undefined): boolean {
  if (!session) return false;
  if (session.archivedAt) return false;
  return session.kind === "channel" || session.origin === "job";
}
