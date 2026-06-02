/**
 * DPoP proof replay protection (RFC 9449 §11.1).
 *
 * Each DPoP proof carries a unique `jti`. A proof may be presented only once
 * within its short freshness window; a replayed `jti` is rejected. We keep a tiny
 * in-process TTL set keyed by jti. The TTL matches the proof's max age, so the
 * memory footprint is bounded and entries self-expire — no DB round-trip on the
 * hot path.
 *
 * Single-process scope is acceptable here: the proof lifetime is minutes, and a
 * captured proof replayed against a different node would still need the matching
 * private key for any *new* request (htm/htu/iat/jti are all signed). The jti
 * cache closes the exact-replay window, which is the documented requirement.
 */
const seen = new Map<string, number>();

/** Lazily evict expired entries; cheap amortized cleanup on each check. */
function sweep(now: number): void {
  if (seen.size === 0) return;
  for (const [jti, exp] of seen) {
    if (exp <= now) seen.delete(jti);
  }
}

/**
 * Record a jti as used. Returns true if this is the FIRST time we have seen it
 * (accept), false if it is a replay (reject). `ttlSec` should be the proof's max
 * age so the entry outlives the window in which the proof is otherwise valid.
 */
export function registerJti(jti: string, ttlSec: number, now = Date.now()): boolean {
  sweep(now);
  const existing = seen.get(jti);
  if (existing !== undefined && existing > now) return false;
  seen.set(jti, now + ttlSec * 1000);
  return true;
}

/** Test helper: clear all remembered jtis. */
export function _resetReplayStore(): void {
  seen.clear();
}
