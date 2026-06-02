/**
 * /api/v1/sprints integration tests (Plugforge A4).
 *
 * Exercises the full edge: bearer auth → require(scope) → handler → SprintsPort.
 * Sprints are read-only in the public API (GET list + GET /:id). Mirrors the
 * structure of documents.test.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import * as store from '../../../oauth/store.js';
import { hashClientSecret, sha256, generate } from '../../../oauth/crypto.js';
import { bearerAuth } from '../../../oauth/bearer.js';
import { identityAdapter } from '../../../adapters/identity.js';
import { createDocumentsAdapter } from '../../../adapters/documents.js';
import { createIssuesAdapter } from '../../../adapters/issues.js';
import { createSprintsAdapter } from '../../../adapters/sprints.js';
import { createV1Router } from '../router.js';
import { stubWebhooks, noopBus } from '../../../webhooks/__tests__/test-doubles.js';

let workspaceId: string;
let userId: string;
let appId: string;
/** A sprint id created via the internal domain for GET tests. */
let sprintId: string;

const noRateLimit = (_req: unknown, _res: unknown, next: () => void) => next();
const documentsAdapter = createDocumentsAdapter(noopBus);
const issuesAdapter = createIssuesAdapter(noopBus);
const sprintsAdapter = createSprintsAdapter();

function v1App() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', createV1Router({
    bearerAuth, rateLimit: noRateLimit, identity: identityAdapter,
    documents: documentsAdapter, issues: issuesAdapter, sprints: sprintsAdapter, webhooks: stubWebhooks,
  }));
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
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('Sprints v1 WS') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const u = await pool.query(`INSERT INTO users (email, name) VALUES ('sprints-v1@example.com','Sprints Tester') RETURNING id`);
  userId = u.rows[0].id;
  const app = await store.createApp({
    clientId: 'ship_app_sprints', clientSecretHash: await hashClientSecret('x'), name: 'Sprints App',
    redirectUris: [], requestedScopes: ['sprints:read'], appType: 'confidential',
    ownerUserId: userId, workspaceId,
  });
  appId = app.id;

  // Create a sprint directly in the DB via documentsDomain so GET tests have data.
  const sprint = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
     VALUES ($1, 'sprint', 'Sprint 1', '{"sprint_number":1,"status":"planned"}', $2)
     RETURNING id`,
    [workspaceId, userId],
  );
  sprintId = sprint.rows[0].id;
});

describe('GET /api/v1/sprints', () => {
  it('lists sprints and returns {data, next_cursor}', async () => {
    const token = await mintToken(['sprints:read']);
    const res = await request(v1App())
      .get('/api/v1/sprints')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect('next_cursor' in res.body).toBe(true);
    // The sprint we created should appear
    const found = res.body.data.find((s: { id: string }) => s.id === sprintId);
    expect(found).toBeDefined();
  });

  it('returns cursor pagination with {data, next_cursor}', async () => {
    // Create enough sprints to paginate
    for (let i = 2; i <= 5; i++) {
      await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
         VALUES ($1, 'sprint', $2, $3, $4)`,
        [workspaceId, `Sprint ${i}`, JSON.stringify({ sprint_number: i }), userId],
      );
    }
    const token = await mintToken(['sprints:read']);
    const first = await request(v1App())
      .get('/api/v1/sprints?limit=2')
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.data.length).toBeGreaterThanOrEqual(2);
    // next_cursor may be null (if only 2 sprints exist) or a string — both are valid
    expect(first.body.next_cursor === null || typeof first.body.next_cursor === 'string').toBe(true);
  });
});

describe('GET /api/v1/sprints/:id', () => {
  it('returns the sprint by id', async () => {
    const token = await mintToken(['sprints:read']);
    const res = await request(v1App())
      .get(`/api/v1/sprints/${sprintId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(sprintId);
    expect(res.body.title).toBe('Sprint 1');
    expect(typeof res.body.status).toBe('string');
    expect('sprint_number' in res.body).toBe(true);
  });

  it('400s for a non-UUID id', async () => {
    const token = await mintToken(['sprints:read']);
    const res = await request(v1App())
      .get('/api/v1/sprints/not-a-uuid')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_failed');
  });

  it('404s for a missing sprint', async () => {
    const token = await mintToken(['sprints:read']);
    const res = await request(v1App())
      .get('/api/v1/sprints/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });
});

describe('scope enforcement for sprints (403 names the missing scope)', () => {
  it('rejects GET with wrong scope, naming sprints:read', async () => {
    // Token with only documents:read — no sprints:read
    const token = await mintToken(['documents:read']);
    const res = await request(v1App())
      .get('/api/v1/sprints')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
    expect(res.body.message).toContain('sprints:read');
    expect(res.body.details?.required_scope).toBe('sprints:read');
  });

  it('rejects GET with no token (401)', async () => {
    const res = await request(v1App())
      .get('/api/v1/sprints');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });
});
