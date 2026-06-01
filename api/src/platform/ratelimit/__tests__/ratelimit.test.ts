/**
 * Rate-limit unit tests: the token bucket and the middleware (X-RateLimit headers
 * + 429 rate_limited ApiError + Retry-After).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { InMemoryTokenBucketLimiter } from '../limiter.js';
import { createRateLimitMiddleware } from '../middleware.js';
import { ApiError } from '../../errors.js';

describe('InMemoryTokenBucketLimiter', () => {
  it('allows up to capacity then denies, reporting remaining + retry', () => {
    const lim = new InMemoryTokenBucketLimiter(3, 1);
    expect(lim.consume('k').allowed).toBe(true);
    expect(lim.consume('k').allowed).toBe(true);
    const third = lim.consume('k');
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const denied = lim.consume('k');
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe(3);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });

  it('keys are independent', () => {
    const lim = new InMemoryTokenBucketLimiter(1, 1);
    expect(lim.consume('a').allowed).toBe(true);
    expect(lim.consume('b').allowed).toBe(true); // different key, own bucket
    expect(lim.consume('a').allowed).toBe(false);
  });
});

function mockRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
  };
  return { res: res as unknown as Response, headers };
}

describe('rate-limit middleware', () => {
  const req = { platformAuth: { tokenId: 't1', appId: 'a1' } } as unknown as Request;

  it('sets X-RateLimit headers and calls next() while under the limit', () => {
    const mw = createRateLimitMiddleware({
      perToken: new InMemoryTokenBucketLimiter(5, 1),
      perApp: new InMemoryTokenBucketLimiter(10, 1),
    });
    const { res, headers } = mockRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(headers['X-RateLimit-Limit']).toBe('5');
    expect(Number(headers['X-RateLimit-Remaining'])).toBe(4);
    expect(headers['X-RateLimit-Reset']).toBeDefined();
  });

  it('429s with a rate_limited ApiError + Retry-After once the bucket is empty', () => {
    const mw = createRateLimitMiddleware({
      perToken: new InMemoryTokenBucketLimiter(1, 1),
      perApp: new InMemoryTokenBucketLimiter(100, 1),
    });
    const { res, headers } = mockRes();
    mw(req, res, vi.fn()); // consume the only token
    const next = vi.fn();
    mw(req, res, next); // now denied
    const err = next.mock.calls[0]?.[0] as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('rate_limited');
    expect(headers['Retry-After']).toBeDefined();
  });
});
