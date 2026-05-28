// Sign-out generation counter for the push registration flow.
//
// Pure module — no react-native / expo imports — so the race-guard
// invariants can be exercised under `bun:test` without loading the
// native surfaces. The production caller in `./push.ts` imports these
// helpers; tests construct sequences directly.
//
// Invariant: every async branch in `registerForPushAsync` that survives
// an `await` boundary must capture the generation on entry and recheck
// it before mutating module state. A sign-out that lands during the
// async window bumps the counter, which invalidates every prior
// capture and aborts the late-arriving side effect.

let generation = 0;

export function currentGeneration(): number {
  return generation;
}

export function captureGeneration(): number {
  return generation;
}

export function bumpGeneration(): number {
  generation += 1;
  return generation;
}

export function isStillCurrent(captured: number): boolean {
  return captured === generation;
}

// Test-only reset so suites starting from a known baseline don't have
// to count prior bumps.
export function __resetForTests(): void {
  generation = 0;
}
