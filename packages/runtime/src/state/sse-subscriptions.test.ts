import { beforeEach, describe, expect, test } from "bun:test";
import type { Instance } from "../types";
import {
  __resetSseSubscriptionsForTests,
  addPushlessSubscription,
  addSseSubscription,
  clearDeviceWatch,
  clearSessionWatch,
  clearStreamWatch,
  hasAnyActiveSubscription,
  isDeviceWatching,
  isSessionWebWatched
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

  test("clearSessionWatch drops only the named session, leaving the device's others", () => {
    addSseSubscription(INST, "tok_a", "chat_x");
    addSseSubscription(INST, "tok_a", "chat_y");
    // Navigating away from chat_x clears only chat_x for this device.
    expect(clearSessionWatch(INST, "tok_a", "chat_x")).toBe(1);
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(false);
    expect(isDeviceWatching(INST, "tok_a", "chat_y")).toBe(true);
  });

  test("clearSessionWatch does NOT touch a session opened on a different device", () => {
    addSseSubscription(INST, "tok_a", "chat_x");
    addSseSubscription(INST, "tok_b", "chat_x");
    expect(clearSessionWatch(INST, "tok_a", "chat_x")).toBe(1);
    expect(isDeviceWatching(INST, "tok_b", "chat_x")).toBe(true);
  });

  test("clearSessionWatch is a no-op (0) for an unknown device or session", () => {
    expect(clearSessionWatch(INST, "tok_none", "chat_x")).toBe(0);
    addSseSubscription(INST, "tok_a", "chat_x");
    expect(clearSessionWatch(INST, "tok_a", "chat_other")).toBe(0);
    // chat_x untouched by the miss.
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(true);
  });

  test("clearSessionWatch clears the last session and prunes the empty device bucket", () => {
    addSseSubscription(INST, "tok_a", "chat_x");
    expect(clearSessionWatch(INST, "tok_a", "chat_x")).toBe(1);
    // Bucket pruned → device reports no active subscriptions.
    expect(hasAnyActiveSubscription(INST, "tok_a")).toBe(false);
  });

  test("clearStreamWatch drops only the named stream, leaving a sibling stream on the same session", () => {
    // The over-clear scenario: the Thread View is presented as a card over
    // the main chat, so both screens open a stream on the SAME session, each
    // with its own streamId. Tearing down the thread must NOT clear the main
    // chat's watch.
    addSseSubscription(INST, "tok_a", "chat_x", "stream_main");
    addSseSubscription(INST, "tok_a", "chat_x", "stream_thread");
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(true);
    // Thread screen unmounts → clears only its own stream.
    expect(clearStreamWatch(INST, "tok_a", "chat_x", "stream_thread")).toBe(1);
    // The main chat's stream is still registered → still watching.
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(true);
    // And clearing the main stream too finally drops the session.
    expect(clearStreamWatch(INST, "tok_a", "chat_x", "stream_main")).toBe(1);
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(false);
  });

  test("clearStreamWatch is a no-op (0) for an unknown device, session, or stream", () => {
    expect(clearStreamWatch(INST, "tok_none", "chat_x", "s1")).toBe(0);
    addSseSubscription(INST, "tok_a", "chat_x", "s1");
    // Wrong session.
    expect(clearStreamWatch(INST, "tok_a", "chat_other", "s1")).toBe(0);
    // Right session, wrong stream id.
    expect(clearStreamWatch(INST, "tok_a", "chat_x", "s2")).toBe(0);
    // The real stream is untouched by the misses.
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(true);
    expect(clearStreamWatch(INST, "tok_a", "chat_x", "s1")).toBe(1);
  });

  test("clearStreamWatch prunes the empty device bucket after the last stream", () => {
    addSseSubscription(INST, "tok_a", "chat_x", "s1");
    expect(clearStreamWatch(INST, "tok_a", "chat_x", "s1")).toBe(1);
    expect(hasAnyActiveSubscription(INST, "tok_a")).toBe(false);
  });

  test("a stream registered with a streamId is still seen by the session-prefix watch check", () => {
    // isDeviceWatching keys on the `${sessionId}::` prefix, which a
    // three-segment `${sessionId}::${streamId}::${nonce}` handle must still
    // satisfy so suppression is unaffected by naming the stream.
    addSseSubscription(INST, "tok_a", "chat_x", "stream_1");
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(true);
    // A bare clearSessionWatch still clears a named stream (legacy path).
    expect(clearSessionWatch(INST, "tok_a", "chat_x")).toBe(1);
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(false);
  });
});

describe("pushless (web/CLI) presence registry", () => {
  beforeEach(() => {
    __resetSseSubscriptionsForTests();
  });

  test("isSessionWebWatched is false when nothing is registered", () => {
    expect(isSessionWebWatched(INST, "chat_x")).toBe(false);
  });

  test("addPushlessSubscription marks the session web-watched until cleanup", () => {
    const cleanup = addPushlessSubscription(INST, "chat_x");
    expect(isSessionWebWatched(INST, "chat_x")).toBe(true);
    // A different session is unaffected.
    expect(isSessionWebWatched(INST, "chat_y")).toBe(false);
    cleanup();
    expect(isSessionWebWatched(INST, "chat_x")).toBe(false);
  });

  test("two web tabs on the same chat survive a single cleanup (ref-counted)", () => {
    // Two browser tabs open on the same chat. Closing one must not clear
    // the presence the other still holds.
    const tabA = addPushlessSubscription(INST, "chat_x");
    const tabB = addPushlessSubscription(INST, "chat_x");
    expect(isSessionWebWatched(INST, "chat_x")).toBe(true);
    tabA();
    expect(isSessionWebWatched(INST, "chat_x")).toBe(true);
    tabB();
    expect(isSessionWebWatched(INST, "chat_x")).toBe(false);
  });

  test("pushless cleanup is idempotent", () => {
    const cleanup = addPushlessSubscription(INST, "chat_x");
    cleanup();
    cleanup();
    expect(isSessionWebWatched(INST, "chat_x")).toBe(false);
  });

  test("pushless presence is isolated per instance", () => {
    const otherInst = "sse-subs-test-other" as Instance;
    const cleanup = addPushlessSubscription(INST, "chat_x");
    expect(isSessionWebWatched(otherInst, "chat_x")).toBe(false);
    cleanup();
  });

  test("pushless and device registries are independent", () => {
    // A web client watching chat_x must NOT make a device look like it's
    // watching chat_x, and vice versa — the two predicates read disjoint
    // state.
    const web = addPushlessSubscription(INST, "chat_x");
    expect(isSessionWebWatched(INST, "chat_x")).toBe(true);
    expect(isDeviceWatching(INST, "tok_a", "chat_x")).toBe(false);
    const dev = addSseSubscription(INST, "tok_a", "chat_y");
    expect(isDeviceWatching(INST, "tok_a", "chat_y")).toBe(true);
    expect(isSessionWebWatched(INST, "chat_y")).toBe(false);
    web();
    dev();
  });

  test("__resetSseSubscriptionsForTests clears pushless presence too", () => {
    addPushlessSubscription(INST, "chat_x");
    __resetSseSubscriptionsForTests();
    expect(isSessionWebWatched(INST, "chat_x")).toBe(false);
  });

  test("a stale pushless cleanup after reset is harmless", () => {
    const cleanup = addPushlessSubscription(INST, "chat_x");
    __resetSseSubscriptionsForTests();
    expect(() => cleanup()).not.toThrow();
    expect(isSessionWebWatched(INST, "chat_x")).toBe(false);
  });
});
