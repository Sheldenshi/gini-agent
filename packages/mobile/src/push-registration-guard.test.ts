// Unit tests for the sign-out generation counter that guards
// mobile/src/push.ts against the registration ↔ sign-out race.
//
// The invariant under test: any captured generation must be
// invalidated by a subsequent bump, and a single bump suffices to
// invalidate every prior capture (multiple concurrent in-flight
// registrations).

import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetForTests,
  bumpGeneration,
  captureGeneration,
  currentGeneration,
  isStillCurrent
} from "./push-registration-guard";

describe("push-registration-guard", () => {
  beforeEach(() => {
    __resetForTests();
  });

  test("a fresh capture is still current with no bumps", () => {
    const captured = captureGeneration();
    expect(isStillCurrent(captured)).toBe(true);
  });

  test("bumpGeneration invalidates a previously captured value", () => {
    const captured = captureGeneration();
    bumpGeneration();
    expect(isStillCurrent(captured)).toBe(false);
  });

  test("each bump increments the current generation", () => {
    const start = currentGeneration();
    bumpGeneration();
    expect(currentGeneration()).toBe(start + 1);
    bumpGeneration();
    expect(currentGeneration()).toBe(start + 2);
  });

  test("multiple bumps each invalidate prior captures", () => {
    const captured1 = captureGeneration();
    bumpGeneration();
    const captured2 = captureGeneration();
    expect(isStillCurrent(captured1)).toBe(false);
    expect(isStillCurrent(captured2)).toBe(true);
    bumpGeneration();
    expect(isStillCurrent(captured1)).toBe(false);
    expect(isStillCurrent(captured2)).toBe(false);
  });

  test("concurrent captures before a bump all become invalidated by one bump", () => {
    // Simulate three in-flight registerForPushAsync calls each
    // capturing the generation before any sign-out lands.
    const capturedA = captureGeneration();
    const capturedB = captureGeneration();
    const capturedC = captureGeneration();
    expect(isStillCurrent(capturedA)).toBe(true);
    expect(isStillCurrent(capturedB)).toBe(true);
    expect(isStillCurrent(capturedC)).toBe(true);

    // Single sign-out bumps once.
    bumpGeneration();

    // All three captures must now short-circuit.
    expect(isStillCurrent(capturedA)).toBe(false);
    expect(isStillCurrent(capturedB)).toBe(false);
    expect(isStillCurrent(capturedC)).toBe(false);
  });

  test("a capture taken after a bump tracks the new generation", () => {
    bumpGeneration();
    const captured = captureGeneration();
    expect(isStillCurrent(captured)).toBe(true);
    bumpGeneration();
    expect(isStillCurrent(captured)).toBe(false);
  });

  test("a credential swap (modeled as a single generation bump) invalidates the prior session's capture but lets a follow-up capture start fresh", () => {
    // Models resetRegistrationForCredentialSwap: a credential swap
    // calls bumpGeneration to drop any in-flight registration that
    // captured the prior credential's generation. After the bump, a
    // brand-new registerForPushAsync invocation captures the new
    // generation and proceeds normally.
    const priorSessionCapture = captureGeneration();
    expect(isStillCurrent(priorSessionCapture)).toBe(true);

    // Simulate the credential swap reset.
    bumpGeneration();

    // The prior session's capture must short-circuit.
    expect(isStillCurrent(priorSessionCapture)).toBe(false);

    // A new capture (the next registerForPushAsync) tracks the new
    // generation and stays current.
    const newSessionCapture = captureGeneration();
    expect(isStillCurrent(newSessionCapture)).toBe(true);
  });
});
