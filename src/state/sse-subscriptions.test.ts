import { beforeEach, describe, expect, test } from "bun:test";
import type { Instance } from "../types";
import {
  __resetSseSubscriptionsForTests,
  addSseSubscription,
  clearDeviceWatch,
  hasAnyActiveSubscription,
  isDeviceWatching
} from "./sse-subscriptions";

const INST = "sse-subs-test" as Instance;

describe("sse-subscriptions registry", () => {
  beforeEach(() => {
    __resetSseSubscriptionsForTests();
  });

  test("isDeviceWatching returns false when nothing is registered", () => {
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(false);
    expect(hasAnyActiveSubscription(INST, "tok_a")).toBe(false);
  });

  test("addSseSubscription registers and the cleanup unregisters", () => {
    const cleanup = addSseSubscription(INST, "tok_a", "chat_x");
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(true);
    expect(hasAnyActiveSubscription(INST, "tok_a")).toBe(true);
    // Wrong session for the same device is still false.
    expect(isDeviceWatching(INST, "tok_a", "chat_y")).toBe(false);
    // Other device tokens (e.g. the human's other iPhone) are unaffected.
    expect(isDeviceWatching(INST, "tok_b", "chat_x")).toBe(false);
    cleanup();
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(false);
    expect(hasAnyActiveSubscription(INST, "tok_a")).toBe(false);
  });

  test("concurrent subscriptions to the same (device, session) survive a single cleanup", () => {
    // Two open SSE streams from the same device (e.g. a reconnect race
    // where the old connection hasn't fully torn down). The first
    // cleanup must NOT wipe the second peer's record.
    const cleanupA = addSseSubscription(INST, "tok_a", "chat_x");
    const cleanupB = addSseSubscription(INST, "tok_a", "chat_x");
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(true);
    cleanupA();
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(true);
    cleanupB();
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(false);
  });

  test("cleanup is idempotent", () => {
    const cleanup = addSseSubscription(INST, "tok_a", "chat_x");
    cleanup();
    cleanup();
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(false);
  });

  test("hasAnyActiveSubscription reports across sessions for one device", () => {
    const c1 = addSseSubscription(INST, "tok_a", "chat_x");
    const c2 = addSseSubscription(INST, "tok_a", "chat_y");
    expect(hasAnyActiveSubscription(INST, "tok_a")).toBe(true);
    c1();
    expect(hasAnyActiveSubscription(INST, "tok_a")).toBe(true);
    c2();
    expect(hasAnyActiveSubscription(INST, "tok_a")).toBe(false);
  });

  test("two devices for the same human are tracked independently", () => {
    // Two iPhones registered under one shared "owner" credential. iPhone
    // A is foregrounded on chat_x; iPhone B is in background. The
    // dispatcher must see A as watching and B as not — that's the whole
    // point of keying on device token rather than credential.
    const cleanupA = addSseSubscription(INST, "tok_iphone_a", "chat_x");
    expect(isDeviceWatching(INST, "tok_iphone_a", "chat_x")).toBe(true);
    expect(isDeviceWatching(INST, "tok_iphone_b", "chat_x")).toBe(false);
    cleanupA();
  });

  test("instances are isolated", () => {
    const otherInst = "sse-subs-test-other" as Instance;
    const cleanup = addSseSubscription(INST, "tok_a", "chat_x");
    expect(isDeviceWatching(otherInst, "tok_a", "chat_x")).toBe(false);
    cleanup();
  });

  test("clearDeviceWatch drops every session for a device in one shot", () => {
    addSseSubscription(INST, "tok_a", "chat_x");
    addSseSubscription(INST, "tok_a", "chat_y");
    addSseSubscription(INST, "tok_b", "chat_x");
    // The backgrounding beacon clears the whole bucket for tok_a.
    expect(clearDeviceWatch(INST, "tok_a")).toBe(2);
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(false);
    expect(isDeviceWatching(INST, "tok_a", "chat_y")).toBe(false);
    expect(hasAnyActiveSubscription(INST, "tok_a")).toBe(false);
    // Other devices are untouched.
    expect(isDeviceWatching(INST, "tok_b", "chat_x")).toBe(true);
  });

  test("clearDeviceWatch is a no-op (returns 0) for a device with no entries", () => {
    expect(clearDeviceWatch(INST, "tok_none")).toBe(0);
    // And idempotent after a real clear.
    addSseSubscription(INST, "tok_a", "chat_x");
    expect(clearDeviceWatch(INST, "tok_a")).toBe(1);
    expect(clearDeviceWatch(INST, "tok_a")).toBe(0);
  });

  test("a stale stream cancel after clearDeviceWatch is harmless", () => {
    // Models the relay case: the beacon clears watch-state, then the
    // long-lived stream's cancel() finally fires and calls its cleanup.
    // The cleanup must not throw or resurrect the entry.
    const cleanup = addSseSubscription(INST, "tok_a", "chat_x");
    expect(clearDeviceWatch(INST, "tok_a")).toBe(1);
    expect(() => cleanup()).not.toThrow();
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(false);
  });
});
