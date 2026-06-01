/**
 * Integration test for the public `/api/v1` edge contract (Slice 1).
 *
 * Mounts the real v1 router on a bare Express app — no session, no CSRF, no
 * internal middleware — and asserts the foundation behaviors that every later
 * route inherits: request-id echo and the ApiError 404 shape.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createV1Router, type PlatformDeps } from '../api/v1/router.js';

const stubDeps: PlatformDeps = {
  // Edge-contract tests only exercise unmatched routes, so the stub deps are
  // never actually invoked.
  bearerAuth: (_req, _res, next) => next(),
  rateLimit: (_req, _res, next) => next(),
  identity: { getUser: vi.fn() },
  documents: { list: vi.fn(), get: vi.fn(), create: vi.fn() },
};

function app() {
  const a = express();
  // No global body parser — the v1 router owns its own parsing (as in app.ts).
  a.use('/api/v1', createV1Router(stubDeps));
  return a;
}

describe('/api/v1 edge', () => {
  it('returns the ApiError shape (not Express HTML) on an unmatched route', async () => {
    const res = await request(app()).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'not_found' });
    expect(typeof res.body.message).toBe('string');
    expect(typeof res.body.request_id).toBe('string');
    expect(res.body.request_id.length).toBeGreaterThan(0);
  });

  it('echoes the request id as X-Request-Id and matches the body', async () => {
    const res = await request(app()).get('/api/v1/nope');
    expect(res.headers['x-request-id']).toBe(res.body.request_id);
  });

  it('honors an inbound X-Request-Id for correlation', async () => {
    const res = await request(app()).get('/api/v1/nope').set('X-Request-Id', 'trace-abc');
    expect(res.headers['x-request-id']).toBe('trace-abc');
    expect(res.body.request_id).toBe('trace-abc');
  });

  it('a malformed JSON body still ships the ApiError shape (not Express HTML)', async () => {
    // The body parser lives INSIDE the v1 router (after request-id), so a parse
    // failure is caught by the v1 error handler — the contract holds for bad bodies.
    const res = await request(app())
      .post('/api/v1/documents')
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', 'trace-bad-body')
      .send('{ this is not valid json ');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.request_id).toBe('trace-bad-body');
  });
});
