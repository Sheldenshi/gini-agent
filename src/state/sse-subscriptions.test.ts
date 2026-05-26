import { beforeEach, describe, expect, test } from "bun:test";
import type { Instance } from "../types";
import {
  __resetSseSubscriptionsForTests,
  addSseSubscription,
  hasAnyActiveSubscription,
  isCredentialWatching
} from "./sse-subscriptions";

const INST = "sse-subs-test" as Instance;

describe("sse-subscriptions registry", () => {
  beforeEach(() => {
    __resetSseSubscriptionsForTests();
  });

  test("isCredentialWatching returns false when nothing is registered", () => {
    expect(isCredentialWatching(INST, "cred_a", "chat_x")).toBe(false);
    expect(hasAnyActiveSubscription(INST, "cred_a")).toBe(false);
  });

  test("addSseSubscription registers and the cleanup unregisters", () => {
    const cleanup = addSseSubscription(INST, "cred_a", "chat_x");
    expect(isCredentialWatching(INST, "cred_a", "chat_x")).toBe(true);
    expect(hasAnyActiveSubscription(INST, "cred_a")).toBe(true);
    // Wrong session for the same credential is still false.
    expect(isCredentialWatching(INST, "cred_a", "chat_y")).toBe(false);
    // Wrong credential is unaffected.
    expect(isCredentialWatching(INST, "cred_b", "chat_x")).toBe(false);
    cleanup();
    expect(isCredentialWatching(INST, "cred_a", "chat_x")).toBe(false);
    expect(hasAnyActiveSubscription(INST, "cred_a")).toBe(false);
  });

  test("concurrent subscriptions to the same (credential, session) survive a single cleanup", () => {
    // Two open SSE streams from the same human (two tabs / two
    // foregrounded devices). The first cleanup must NOT wipe the
    // second peer's record.
    const cleanupA = addSseSubscription(INST, "cred_a", "chat_x");
    const cleanupB = addSseSubscription(INST, "cred_a", "chat_x");
    expect(isCredentialWatching(INST, "cred_a", "chat_x")).toBe(true);
    cleanupA();
    expect(isCredentialWatching(INST, "cred_a", "chat_x")).toBe(true);
    cleanupB();
    expect(isCredentialWatching(INST, "cred_a", "chat_x")).toBe(false);
  });

  test("cleanup is idempotent", () => {
    const cleanup = addSseSubscription(INST, "cred_a", "chat_x");
    cleanup();
    cleanup();
    expect(isCredentialWatching(INST, "cred_a", "chat_x")).toBe(false);
  });

  test("hasAnyActiveSubscription reports across sessions for one credential", () => {
    const c1 = addSseSubscription(INST, "cred_a", "chat_x");
    const c2 = addSseSubscription(INST, "cred_a", "chat_y");
    expect(hasAnyActiveSubscription(INST, "cred_a")).toBe(true);
    c1();
    expect(hasAnyActiveSubscription(INST, "cred_a")).toBe(true);
    c2();
    expect(hasAnyActiveSubscription(INST, "cred_a")).toBe(false);
  });

  test("instances are isolated", () => {
    const otherInst = "sse-subs-test-other" as Instance;
    const cleanup = addSseSubscription(INST, "cred_a", "chat_x");
    expect(isCredentialWatching(otherInst, "cred_a", "chat_x")).toBe(false);
    cleanup();
  });
});
