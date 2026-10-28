import { describe, expect, it } from "bun:test";
import { createTokenBucketRateLimiter } from "../../src/rateLimit";

const START = Date.UTC(2025, 0, 1, 12, 0, 0);

describe("createTokenBucketRateLimiter", () => {
  it("allows a burst up to the configured per-minute limit", () => {
    const limiter = createTokenBucketRateLimiter({ limitPerMinute: 3 });

    expect(limiter.consume("user-1", START).allowed).toBe(true);
    expect(limiter.consume("user-1", START).allowed).toBe(true);
    expect(limiter.consume("user-1", START).allowed).toBe(true);
    expect(limiter.consume("user-1", START).allowed).toBe(false);
  });

  it("reports how long the caller must wait", () => {
    const limiter = createTokenBucketRateLimiter({ limitPerMinute: 1 });

    expect(limiter.consume("user-1", START).allowed).toBe(true);
    const denied = limiter.consume("user-1", START);

    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("refills tokens over time", () => {
    const limiter = createTokenBucketRateLimiter({ limitPerMinute: 60 });

    for (let index = 0; index < 60; index += 1) {
      expect(limiter.consume("user-1", START).allowed).toBe(true);
    }

    expect(limiter.consume("user-1", START).allowed).toBe(false);
    expect(limiter.consume("user-1", START + 1_000).allowed).toBe(true);
  });

  it("caps refilled tokens at the burst size", () => {
    const limiter = createTokenBucketRateLimiter({ limitPerMinute: 2 });

    limiter.consume("user-1", START);
    limiter.consume("user-1", START);
    expect(limiter.consume("user-1", START + 600_000).allowed).toBe(true);
    expect(limiter.consume("user-1", START + 600_000).allowed).toBe(true);
    expect(limiter.consume("user-1", START + 600_000).allowed).toBe(false);
  });

  it("keeps buckets independent per user", () => {
    const limiter = createTokenBucketRateLimiter({ limitPerMinute: 1 });

    expect(limiter.consume("user-1", START).allowed).toBe(true);
    expect(limiter.consume("user-1", START).allowed).toBe(false);
    expect(limiter.consume("user-2", START).allowed).toBe(true);
  });

  it("bounds memory by evicting the oldest bucket", () => {
    const limiter = createTokenBucketRateLimiter({ limitPerMinute: 1, maxBuckets: 2 });

    expect(limiter.consume("user-1", START).allowed).toBe(true);
    expect(limiter.consume("user-2", START).allowed).toBe(true);
    expect(limiter.consume("user-3", START).allowed).toBe(true);
    // user-1 was evicted, so it starts with a fresh bucket again.
    expect(limiter.consume("user-1", START).allowed).toBe(true);
  });
});
