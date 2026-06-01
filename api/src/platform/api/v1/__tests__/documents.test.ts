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
let otherUserId: string;
let appId: string;

function v1App() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', createV1Router({ bearerAuth, identity: identityAdapter, documents: documentsAdapter }));
  return a;
}

/** Mint an access token directly with the given scopes. */
async function mintToken(
  scopes: string[],
  subjectUserId: string | null = userId,
  grantType = 'authorization_code',
): Promise<string> {
  const raw = generate.accessToken();
  await store.insertAccessToken({
    tokenHash: sha256(raw), appId, userId: subjectUserId, workspaceId, scopes,
    grantType, expiresAt: new Date(Date.now() + 3600_000),
  });
  return raw;
}

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('Docs v1 WS') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const u = await pool.query(`INSERT INTO users (email, name) VALUES ('docs-v1@example.com','Docs Tester') RETURNING id`);
  userId = u.rows[0].id;
  const otherUser = await pool.query(
    `INSERT INTO users (email, name) VALUES ('docs-v1-other@example.com','Docs Other User') RETURNING id`,
  );
  otherUserId = otherUser.rows[0].id;
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
    [workspaceId, userId, otherUserId],
  );
  const app = await store.createApp({
    clientId: 'ship_app_docs', clientSecretHash: await hashClientSecret('x'), name: 'Docs App',
    redirectUris: [], requestedScopes: ['documents:read', 'documents:write'], appType: 'confidential',
    ownerUserId: userId, workspaceId,
  });
  appId = app.id;
});

describe('document visibility', () => {
  it('omits and 404s another user private document', async () => {
    const privateDoc = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
       VALUES ($1, 'program', 'Owner Private Program', 'private', $2)
       RETURNING id`,
      [workspaceId, userId],
    );
    const workspaceDoc = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, visibility, created_by)
       VALUES ($1, 'program', 'Workspace Program', 'workspace', $2)
       RETURNING id`,
      [workspaceId, userId],
    );
    const token = await mintToken(['documents:read'], otherUserId);

    const list = await request(v1App())
      .get('/api/v1/documents?document_type=program&limit=100')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const ids = list.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(workspaceDoc.rows[0].id);
    expect(ids).not.toContain(privateDoc.rows[0].id);

    const fetched = await request(v1App())
      .get(`/api/v1/documents/${privateDoc.rows[0].id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(fetched.status).toBe(404);
    expect(fetched.body).toMatchObject({ code: 'not_found' });
  });
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
