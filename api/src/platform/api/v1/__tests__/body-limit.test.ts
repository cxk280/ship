import { describe, expect, it } from 'vitest';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { createV1Router } from '../router.js';
import type { DocumentsPort, IdentityPort, PublicDocument } from '../ports.js';
import '../../../types.js';

const bearerAuth: RequestHandler = (req, _res, next) => {
  req.platformAuth = {
    appId: 'app_1',
    clientId: 'ship_app_test',
    userId: 'user_1',
    workspaceId: 'workspace_1',
    scopes: ['documents:read', 'documents:write'],
    tokenId: 'token_1',
  };
  next();
};

const identity: IdentityPort = {
  async getUser() {
    return { id: 'user_1', email: 'user@example.com', name: 'Test User' };
  },
};

const noRateLimit: RequestHandler = (_req, _res, next) => next();
import { stubWebhooks, stubIssues, stubSprints } from '../../../webhooks/__tests__/test-doubles.js';

function publicDoc(content: unknown): PublicDocument {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    document_type: 'wiki',
    title: 'Large wiki',
    content,
    properties: {},
    parent_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function v1App(documents: DocumentsPort) {
  const app = express();
  app.use('/api/v1', createV1Router({ bearerAuth, rateLimit: noRateLimit, identity, documents, issues: stubIssues, sprints: stubSprints, webhooks: stubWebhooks }));
  return app;
}

describe('/api/v1 body parser limit', () => {
  it('accepts public document creation payloads over 1 MB and under 10 MB', async () => {
    const largeContent = 'x'.repeat(1024 * 1024 + 1);
    const documents: DocumentsPort = {
      async list() {
        return { data: [], next_cursor: null };
      },
      async get() {
        return null;
      },
      async create(input) {
        return publicDoc(input.content);
      },
    };

    const res = await request(v1App(documents))
      .post('/api/v1/documents')
      .set('Authorization', 'Bearer test-token')
      .send({ title: 'Large wiki', document_type: 'wiki', content: largeContent });

    expect(res.status).toBe(201);
    expect(res.body.content).toHaveLength(largeContent.length);
  });
});
