/**
 * Idempotency-Key integration tests (Plugforge B6).
 *
 * Verifies Stripe-grade exactly-once semantics on POST writes:
 *  (a) Two POSTs with the same key + same body → only one document created,
 *      second response is byte-identical + Idempotency-Replayed: true.
 *  (b) Same key + DIFFERENT body → 422 validation_failed.
 *  (c) No key → normal behavior (two independent documents created).
 *
 * Setup mirrors documents.test.ts (real bearer auth, real DB, no mocks except
 * rate-limit). DATABASE_URL=postgres://christopherking@localhost:5432/ship_test
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
import { createIdempotencyAdapter } from '../../../adapters/idempotency.js';
import { createV1Router } from '../router.js';
import { stubWebhooks, stubIssues, stubSprints, stubAudit, noopBus } from '../../../webhooks/__tests__/test-doubles.js';

let workspaceId: string;
let userId: string;
let appId: string;

const noRateLimit = (_req: unknown, _res: unknown, next: () => void) => next();
const documentsAdapter = createDocumentsAdapter(noopBus);
const idempotencyAdapter = createIdempotencyAdapter();

function v1App() {
  const a = express();
  a.use(express.json());
  a.use(
    '/api/v1',
    createV1Router({
      bearerAuth,
      rateLimit: noRateLimit,
      identity: identityAdapter,
      documents: documentsAdapter,
      issues: stubIssues,
      sprints: stubSprints,
      webhooks: stubWebhooks,
      audit: stubAudit,
      idempotency: idempotencyAdapter,
    }),
  );
  return a;
}

/** Mint an access token directly with the given scopes. */
async function mintToken(scopes: string[]): Promise<string> {
  const raw = generate.accessToken();
  await store.insertAccessToken({
    tokenHash: sha256(raw),
    appId,
    userId,
    workspaceId,
    scopes,
    grantType: 'authorization_code',
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return raw;
}

beforeAll(async () => {
  // Run migration 048 in the test DB if it hasn't been applied yet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      app_id            uuid        NOT NULL,
      idempotency_key   text        NOT NULL,
      fingerprint       text        NOT NULL,
      status            text        NOT NULL DEFAULT 'in_progress',
      response_status   int,
      response_body     jsonb,
      created_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (app_id, idempotency_key)
    )
  `);

  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('Idempotency WS') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const u = await pool.query(
    `INSERT INTO users (email, name) VALUES ('idempotency-test@example.com','Idempotency Tester') RETURNING id`,
  );
  userId = u.rows[0].id;
  const app = await store.createApp({
    clientId: 'ship_app_idempotency',
    clientSecretHash: await hashClientSecret('x'),
    name: 'Idempotency App',
    redirectUris: [],
    requestedScopes: ['documents:read', 'documents:write'],
    appType: 'confidential',
    ownerUserId: userId,
    workspaceId,
  });
  appId = app.id;
});

describe('(a) same key + same body → exactly-once semantics', () => {
  it('replays the first response on the second POST without creating a duplicate', async () => {
    const token = await mintToken(['documents:read', 'documents:write']);
    const app = v1App();
    const key = `test-key-same-${Date.now()}`;

    const first = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ title: 'Idempotent doc', document_type: 'wiki' });

    expect(first.status).toBe(201);
    expect(first.headers['idempotency-replayed']).toBe('false');

    const second = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ title: 'Idempotent doc', document_type: 'wiki' });

    expect(second.status).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');

    // Response body is byte-identical.
    expect(second.body).toEqual(first.body);

    // Only one document was actually created.
    const rows = await pool.query(
      `SELECT id FROM documents WHERE workspace_id = $1 AND title = 'Idempotent doc'`,
      [workspaceId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].id).toBe(first.body.id);
  });
});

describe('(b) same key + different body → 422 validation_failed', () => {
  it('rejects key reuse with a different payload', async () => {
    const token = await mintToken(['documents:read', 'documents:write']);
    const app = v1App();
    const key = `test-key-mismatch-${Date.now()}`;

    const first = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ title: 'Original doc', document_type: 'wiki' });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ title: 'Different doc', document_type: 'wiki' });

    expect(second.status).toBe(422);
    expect(second.body.code).toBe('validation_failed');
    expect(second.body.message).toContain('Idempotency-Key was reused with a different request');
  });
});

describe('(c) no key → normal behavior', () => {
  it('creates two independent documents when no Idempotency-Key is sent', async () => {
    const token = await mintToken(['documents:read', 'documents:write']);
    const app = v1App();
    const title = `No-key doc ${Date.now()}`;

    const first = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title, document_type: 'wiki' });

    const second = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title, document_type: 'wiki' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Two distinct documents created.
    expect(first.body.id).not.toBe(second.body.id);
    // No replay header on either.
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(second.headers['idempotency-replayed']).toBeUndefined();
  });
});
