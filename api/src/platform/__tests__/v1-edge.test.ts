/**
 * Integration test for the public `/api/v1` edge contract (Slice 1).
 *
 * Mounts the real v1 router on a bare Express app — no session, no CSRF, no
 * internal middleware — and asserts the foundation behaviors that every later
 * route inherits: request-id echo and the ApiError 404 shape.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../../app.js';
import { createV1Router } from '../api/v1/router.js';

function app() {
  const a = express();
  a.use('/api/v1', createV1Router());
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

  it('keeps malformed JSON in the ApiError shape in the real app pipeline', async () => {
    const res = await request(createApp())
      .post('/api/v1/nope')
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', 'bad-json-rid')
      .send('{"unterminated":');

    expect(res.status).toBe(400);
    expect(res.headers['x-request-id']).toBe('bad-json-rid');
    expect(res.body).toMatchObject({
      code: 'validation_failed',
      message: 'Malformed request body',
      request_id: 'bad-json-rid',
    });
    expect(res.text).not.toContain('<html');
  });

  it('keeps over-limit bodies in the ApiError shape in the real app pipeline', async () => {
    const res = await request(createApp())
      .post('/api/v1/nope')
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', 'too-large-rid')
      .send({ payload: 'x'.repeat(10 * 1024 * 1024) });

    expect(res.status).toBe(400);
    expect(res.headers['x-request-id']).toBe('too-large-rid');
    expect(res.body).toMatchObject({
      code: 'validation_failed',
      message: 'Request body too large',
      request_id: 'too-large-rid',
    });
    expect(res.text).not.toContain('<html');
  });
});
