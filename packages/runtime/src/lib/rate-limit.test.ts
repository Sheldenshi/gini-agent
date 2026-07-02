import { describe, expect, test } from "bun:test";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  test("allows up to capacity then blocks within the same instant", () => {
    const limiter = new RateLimiter({ capacity: 3, refillPerSec: 0 });
    const t = 1_000;
    expect(limiter.tryConsume("k", t)).toBe(true);
    expect(limiter.tryConsume("k", t)).toBe(true);
    expect(limiter.tryConsume("k", t)).toBe(true);
    expect(limiter.tryConsume("k", t)).toBe(false);
  });

  test("refills lazily based on elapsed time", () => {
    const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1 });
    expect(limiter.tryConsume("k", 0)).toBe(true);
    expect(limiter.tryConsume("k", 0)).toBe(true);
    expect(limiter.tryConsume("k", 0)).toBe(false);
    // one token regenerates after 1s
    expect(limiter.tryConsume("k", 1_000)).toBe(true);
    expect(limiter.tryConsume("k", 1_000)).toBe(false);
  });

  test("refill is capped at capacity", () => {
    const limiter = new RateLimiter({ capacity: 2, refillPerSec: 100 });
    expect(limiter.tryConsume("k", 0)).toBe(true);
    // huge elapsed time cannot exceed capacity: 2 tokens available, then blocked
    expect(limiter.tryConsume("k", 10_000)).toBe(true);
    expect(limiter.tryConsume("k", 10_000)).toBe(true);
    expect(limiter.tryConsume("k", 10_000)).toBe(false);
  });

  test("tracks keys independently and a fresh key starts full", () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0 });
    expect(limiter.tryConsume("a", 0)).toBe(true);
    expect(limiter.tryConsume("a", 0)).toBe(false);
    expect(limiter.tryConsume("b", 0)).toBe(true);
  });

  test("reset clears all buckets", () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0 });
    expect(limiter.tryConsume("a", 0)).toBe(true);
    expect(limiter.tryConsume("a", 0)).toBe(false);
    limiter.reset();
    expect(limiter.tryConsume("a", 0)).toBe(true);
  });

  test("defaults nowMs to the wall clock", () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0 });
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  test("bounds the bucket map under a flood of distinct keys (maxKeys)", () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0, maxKeys: 3 });
    // 10 distinct keys at the same instant; refillPerSec 0 so none ever refill,
    // so the sweep can reclaim nothing. Overflow keys are still allowed (each gets
    // a transient full bucket) but are NOT retained, so the map stays capped.
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.tryConsume(`k${i}`, 1_000)).toBe(true);
    }
    expect(limiter.size).toBe(3);
  });

  test("evicts fully-refilled idle buckets to make room for new keys", () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1, maxKeys: 2 });
    expect(limiter.tryConsume("a", 0)).toBe(true);
    expect(limiter.tryConsume("b", 0)).toBe(true);
    expect(limiter.size).toBe(2);
    // After 5s both a and b have refilled to capacity (idle). A new key at the cap
    // triggers a sweep that drops them, then stores the newcomer.
    expect(limiter.tryConsume("c", 5_000)).toBe(true);
    expect(limiter.size).toBe(1);
  });
});
