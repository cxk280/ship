/**
 * Public-edge rate-limit middleware. Runs after bearer auth so it can key by the
 * authenticated app + token (per-app AND per-token buckets, PRD). Sets
 * X-RateLimit-Limit / -Remaining / -Reset on every response and returns a
 * rate_limited ApiError + Retry-After on 429.
 */
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../errors.js';
import type { IRateLimiter } from './limiter.js';

export function createRateLimitMiddleware(deps: { perToken: IRateLimiter; perApp: IRateLimiter }) {
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const auth = req.platformAuth;
    // Key by token (tight) and app (loose). Unauthenticated fall back to IP so the
    // few public routes are still protected.
    const tokenKey = auth ? `tok:${auth.tokenId}` : `ip:${req.ip}`;
    const appKey = auth ? `app:${auth.appId}` : `ip:${req.ip}`;

    const t = deps.perToken.consume(tokenKey);
    const a = deps.perApp.consume(appKey);
    // Report the more-restrictive bucket in the headers.
    const tighter = t.remaining <= a.remaining ? t : a;

    res.setHeader('X-RateLimit-Limit', String(tighter.limit));
    res.setHeader('X-RateLimit-Remaining', String(tighter.remaining));
    res.setHeader('X-RateLimit-Reset', String(tighter.resetSec));

    if (!t.allowed || !a.allowed) {
      const retry = Math.max(t.retryAfterSec, a.retryAfterSec);
      res.setHeader('Retry-After', String(retry));
      next(ApiError.rateLimited('Rate limit exceeded', { retry_after_seconds: retry }));
      return;
    }
    next();
  };
}
