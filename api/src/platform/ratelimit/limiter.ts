/**
 * Token-bucket rate limiting for the public edge.
 *
 * IRateLimiter is the seam (DIP): the in-memory bucket below is the must-ship
 * implementation; a Redis/Upstash-backed limiter is a Liskov-substitutable drop-in
 * (same interface, same headers). Burst = capacity; sustained rate = refillPerSec.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Bucket capacity (the X-RateLimit-Limit value). */
  limit: number;
  /** Whole tokens remaining after this request. */
  remaining: number;
  /** Unix seconds when the bucket is full again. */
  resetSec: number;
  /** Seconds to wait before retrying (0 when allowed). */
  retryAfterSec: number;
}

export interface IRateLimiter {
  consume(key: string, cost?: number): RateLimitResult;
}

interface Bucket {
  tokens: number;
  last: number; // ms
}

export class InMemoryTokenBucketLimiter implements IRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {}

  consume(key: string, cost = 1): RateLimitResult {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    }
    // Refill based on elapsed time, capped at capacity.
    const elapsedSec = (now - b.last) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.last = now;

    const allowed = b.tokens >= cost;
    if (allowed) b.tokens -= cost;

    const deficit = Math.max(0, cost - b.tokens);
    const retryAfterSec = allowed ? 0 : Math.ceil(deficit / this.refillPerSec);
    const secondsToFull = (this.capacity - b.tokens) / this.refillPerSec;

    return {
      allowed,
      limit: this.capacity,
      remaining: Math.max(0, Math.floor(b.tokens)),
      resetSec: Math.ceil(now / 1000 + secondsToFull),
      retryAfterSec,
    };
  }
}
