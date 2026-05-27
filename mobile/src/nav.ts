// Module-scoped throttle for stack navigation. Two rapid pushes (or a
// back + push race when the user taps a different chat before the pop
// animation of the previous one settles) can drive react-native-screens'
// setViewToSnapshot path into a state where UIKit's snapshot of the
// leaving screen throws — observed as a SIGABRT in production on
// iOS 26 (TestFlight crashlog 2026-05-27, react-native-screens 4.16.0).
// The native stack animation runs ~300ms; 350ms gives the snapshot
// capture + unmount enough room to settle before the next transition
// begins. A drop here is preferred over queueing: a user who taps a
// second chat row at exactly the same instant as the back button is
// almost certainly mis-tapping, not asking for a queued navigation.
const LOCKOUT_MS = 350;
let lastNavAt = 0;

export function nav(fn: () => void): void {
  const now = Date.now();
  if (now - lastNavAt < LOCKOUT_MS) return;
  lastNavAt = now;
  fn();
}
