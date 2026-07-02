// A small in-process token-bucket rate limiter. Used to throttle the public
// pairing-request endpoint so a relay caller can't flood the operator's
// approval panel (approval-fatigue / DoS). Per-process and per-instance is the
// deployment model, so an in-memory Map is sufficient.
//
// The clock is injectable (nowMs) so tests drive refill deterministically
// without sleeping, per the repo's fast-test rules.

export interface RateLimitOptions {
  // Maximum tokens (the burst size).
  capacity: number;
  // Tokens regenerated per second.
  refillPerSec: number;
  // Hard cap on the number of distinct keys retained. Without it, a caller that
  // can vary the key (e.g. the Host header on a public endpoint) could grow the
  // bucket map without bound — a memory-exhaustion DoS. Defaults to 10_000.
  maxKeys?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimitOptions) {}

  // Number of buckets currently retained. Exposed for observability and tests
  // (so a test can assert the map stays bounded under a flood of distinct keys).
  get size(): number {
    return this.buckets.size;
  }

  // Attempt to consume one token for `key`. Returns true when allowed (a token
  // was consumed), false when the bucket is empty (rate limited). Refills lazily
  // based on elapsed time since the bucket was last touched.
  tryConsume(key: string, nowMs: number = Date.now()): boolean {
    const existing = this.buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: this.options.capacity, updatedAt: nowMs };
    const elapsedSec = Math.max(0, nowMs - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.options.capacity, bucket.tokens + elapsedSec * this.options.refillPerSec);
    bucket.updatedAt = nowMs;
    let allowed: boolean;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      allowed = true;
    } else {
      allowed = false;
    }
    if (existing) {
      // A tracked key always stays accurate.
      this.buckets.set(key, bucket);
    } else {
      // New key: bound the map. Reclaim fully-refilled (idle) buckets first, then
      // store only if still under the cap. Beyond the cap an overflow key isn't
      // retained — it gets a transient full bucket each call (its per-key
      // sub-limit relaxes), but the map can't grow without bound and any paired
      // global limiter still throttles total throughput.
      const max = this.options.maxKeys ?? DEFAULT_MAX_KEYS;
      if (this.buckets.size >= max) this.evictRefilled(nowMs);
      if (this.buckets.size < max) this.buckets.set(key, bucket);
    }
    return allowed;
  }

  // Drop buckets that have refilled back to capacity — idle long enough to be
  // indistinguishable from a fresh key, so removing them changes no caller's
  // effective rate while reclaiming space.
  private evictRefilled(nowMs: number): void {
    for (const [k, b] of this.buckets) {
      const refilled = Math.min(
        this.options.capacity,
        b.tokens + (Math.max(0, nowMs - b.updatedAt) / 1000) * this.options.refillPerSec
      );
      if (refilled >= this.options.capacity) this.buckets.delete(k);
    }
  }

  // Test/maintenance hook: drop all buckets.
  reset(): void {
    this.buckets.clear();
  }
}
