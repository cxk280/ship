/**
 * /api/v1/documents integration tests (MVP gate #4 + #6).
 *
 * Exercises the full edge: bearer auth → require(scope) → handler → domain, plus
 * cursor pagination and the 403-names-missing-scope contract.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import * as store from '../../../oauth/store.js';
import { hashClientSecret, sha256, generate } from '../../../oauth/crypto.js';
import { bearerAuth } from '../../../oauth/bearer.js';
import { identityAdapter } from '../../../adapters/identity.js';
import { documentsAdapter } from '../../../adapters/documents.js';
import { createV1Router } from '../router.js';

let workspaceId: string;
let userId: string;
let appId: string;

function v1App() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', createV1Router({ bearerAuth, identity: identityAdapter, documents: documentsAdapter }));
  return a;
}

/** Mint an access token directly with the given scopes. */
async function mintToken(scopes: string[]): Promise<string> {
  const raw = generate.accessToken();
  await store.insertAccessToken({
    tokenHash: sha256(raw), appId, userId, workspaceId, scopes,
    grantType: 'authorization_code', expiresAt: new Date(Date.now() + 3600_000),
  });
  return raw;
}

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('Docs v1 WS') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const u = await pool.query(`INSERT INTO users (email, name) VALUES ('docs-v1@example.com','Docs Tester') RETURNING id`);
  userId = u.rows[0].id;
  const app = await store.createApp({
    clientId: 'ship_app_docs', clientSecretHash: await hashClientSecret('x'), name: 'Docs App',
    redirectUris: [], requestedScopes: ['documents:read', 'documents:write'], appType: 'confidential',
    ownerUserId: userId, workspaceId,
  });
  appId = app.id;
});

describe('POST + GET /api/v1/documents', () => {
  it('creates a document (201) and reads it back by id', async () => {
    const token = await mintToken(['documents:read', 'documents:write']);
    const created = await request(v1App())
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Hello from the SDK', document_type: 'wiki' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Hello from the SDK', document_type: 'wiki' });
    expect(typeof created.body.id).toBe('string');

    const fetched = await request(v1App())
      .get(`/api/v1/documents/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(created.body.id);
  });

  it('404s (ApiError) for a missing document', async () => {
    const token = await mintToken(['documents:read']);
    const res = await request(v1App())
      .get('/api/v1/documents/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'not_found' });
    expect(res.body.request_id).toBeTruthy();
  });
});

describe('cursor pagination', () => {
  it('returns {data, next_cursor} and walks pages with an opaque cursor', async () => {
    const token = await mintToken(['documents:read', 'documents:write']);
    // Create a clean sub-workspace would be ideal; instead create a unique type batch.
    for (let i = 0; i < 5; i++) {
      await request(v1App())
        .post('/api/v1/documents')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: `Page doc ${i}`, document_type: 'issue' });
    }
    const first = await request(v1App())
      .get('/api/v1/documents?document_type=issue&limit=2')
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(typeof first.body.next_cursor).toBe('string');
    // cursor is opaque base64
    expect(first.body.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);

    const second = await request(v1App())
      .get(`/api/v1/documents?document_type=issue&limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`)
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    // No overlap between pages.
    const firstIds = new Set(first.body.data.map((d: { id: string }) => d.id));
    for (const d of second.body.data) expect(firstIds.has(d.id)).toBe(false);
  });
});

describe('scope enforcement (403 names the missing scope)', () => {
  it('rejects POST with a read-only token, naming documents:write', async () => {
    const token = await mintToken(['documents:read']);
    const res = await request(v1App())
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Should fail' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
    expect(res.body.message).toContain('documents:write');
    expect(res.body.details?.required_scope).toBe('documents:write');
  });
});
