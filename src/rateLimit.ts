/**
 * Per-user token bucket, in-process and per pod (architecture §5: rate limits
 * are sized to the replica count, no shared state).
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the next token is available (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, nowMs?: number): RateLimitDecision;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

export interface TokenBucketOptions {
  /** Sustained rate: tokens added per minute (the burst equals this value). */
  limitPerMinute: number;
  /** Upper bound on tracked users so a hostile caller cannot grow memory. */
  maxBuckets?: number;
}

export function createTokenBucketRateLimiter(options: TokenBucketOptions): RateLimiter {
  const capacity = Math.max(1, options.limitPerMinute);
  const refillPerMs = capacity / 60_000;
  const maxBuckets = options.maxBuckets ?? 10_000;
  const buckets = new Map<string, Bucket>();

  return {
    consume(key: string, nowMs: number = Date.now()): RateLimitDecision {
      const now = nowMs;
      const existing = buckets.get(key);

      if (!existing && buckets.size >= maxBuckets) {
        // Drop the oldest entry; the map preserves insertion order.
        const oldestKey = buckets.keys().next().value;

        if (oldestKey !== undefined) {
          buckets.delete(oldestKey);
        }
      }

      const bucket: Bucket = existing ?? { tokens: capacity, updatedAtMs: now };
      const elapsedMs = Math.max(0, now - bucket.updatedAtMs);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedMs * refillPerMs);
      bucket.updatedAtMs = now;

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        buckets.set(key, bucket);

        return { allowed: true, retryAfterSeconds: 0 };
      }

      buckets.set(key, bucket);

      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)),
      };
    },
  };
}
