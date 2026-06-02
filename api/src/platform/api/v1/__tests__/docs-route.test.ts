/**
 * Tests for GET /api/v1/docs — the hosted interactive API reference page.
 *
 * Asserts:
 *  1. Returns HTTP 200 with Content-Type text/html (no auth required).
 *  2. Response body references the live OpenAPI spec URL (/api/v1/openapi.json).
 *  3. Route is unauthenticated — no bearer token needed.
 */
import { describe, it, expect } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { createV1Router } from '../router.js';
import '../../../types.js';
import { stubWebhooks, stubIssues, stubSprints, stubAudit, stubIdempotency } from '../../../webhooks/__tests__/test-doubles.js';
import type { DocumentsPort, IdentityPort } from '../ports.js';

// Minimal stub deps — docs route never touches auth or domain services.
const noopBearerAuth: RequestHandler = (_req, _res, next) => next();
const noRateLimit: RequestHandler = (_req, _res, next) => next();

const stubIdentity: IdentityPort = {
  async getUser() {
    return { id: 'user_1', email: 'user@example.com', name: 'Test User' };
  },
};

const stubDocuments: DocumentsPort = {
  async list() { return { data: [], next_cursor: null }; },
  async get() { return null; },
  async create() {
    return {
      id: '00000000-0000-4000-8000-000000000001',
      document_type: 'wiki',
      title: 'stub',
      content: '',
      properties: {},
      parent_id: null,
      created_at: '1970-01-01T00:00:00.000Z',
      updated_at: '1970-01-01T00:00:00.000Z',
    };
  },
};

function docsApp() {
  const app = express();
  app.use(
    '/api/v1',
    createV1Router({
      bearerAuth: noopBearerAuth,
      rateLimit: noRateLimit,
      identity: stubIdentity,
      documents: stubDocuments,
      issues: stubIssues,
      sprints: stubSprints,
      webhooks: stubWebhooks,
      audit: stubAudit,
      idempotency: stubIdempotency,
    }),
  );
  return app;
}

describe('GET /api/v1/docs', () => {
  it('returns 200 with Content-Type text/html', async () => {
    const res = await request(docsApp()).get('/api/v1/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('references /api/v1/openapi.json in the response body', async () => {
    const res = await request(docsApp()).get('/api/v1/docs');
    expect(res.text).toContain('/api/v1/openapi.json');
  });

  it('requires no Authorization header (unauthenticated access)', async () => {
    // Hit the route with no bearer token at all — should still be 200.
    const res = await request(docsApp())
      .get('/api/v1/docs')
      .unset('Authorization');
    expect(res.status).toBe(200);
  });

  it('contains the Scalar CDN script reference', async () => {
    const res = await request(docsApp()).get('/api/v1/docs');
    expect(res.text).toContain('@scalar/api-reference');
  });

  it('contains the Ship API Reference title', async () => {
    const res = await request(docsApp()).get('/api/v1/docs');
    expect(res.text).toContain('Ship API Reference');
  });
});
