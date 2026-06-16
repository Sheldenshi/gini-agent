// Completion-button label for a browser.connect setup card. The card is
// two-stage: before the visible window opens the button reads "Connect";
// after open-browser flips payload.signInStarted the button signals
// completion. The completion wording is driven by the payload's `mode`,
// stamped by the dispatcher: the default sign-in unblock keeps the
// historical "I've signed in", while a sensitive-step handoff (the user
// finishes payment entry / a final confirmation themselves) reads
// "I'm done" — see ADR browser-connect-handoff.md. Any payload without
// mode:"handoff" (including every pre-existing row) renders the sign-in
// wording unchanged.
export function browserConnectButtonLabel(
  payload: Record<string, unknown> | null | undefined,
  started: boolean
): string {
  if (!started) return "Connect";
  return payload?.mode === "handoff" ? "I'm done" : "I've signed in";
}
