/**
 * HTTP-level tests: the /oauth/token endpoint, the bearer middleware on /api/v1,
 * and /api/v1/me — the spine of MVP gate items #3 and #8.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { pool } from '../../../db/client.js';
import * as service from '../service.js';
import * as store from '../store.js';
import { hashClientSecret, sha256, generate } from '../crypto.js';
import { createOAuthRouter } from '../routes.js';
import { createV1Router } from '../../api/v1/router.js';
import { bearerAuth } from '../bearer.js';
import { identityAdapter } from '../../adapters/identity.js';
import { createDocumentsAdapter } from '../../adapters/documents.js';
import { createIssuesAdapter } from '../../adapters/issues.js';
import { createSprintsAdapter } from '../../adapters/sprints.js';
import { stubWebhooks, stubAudit, noopBus } from '../../webhooks/__tests__/test-doubles.js';

const documentsAdapter = createDocumentsAdapter(noopBus);
const issuesAdapter = createIssuesAdapter(noopBus);
const sprintsAdapter = createSprintsAdapter();

const SECRET = 'ship_secret_http_known';
let workspaceId: string;
let userId: string;
let app: store.OAuthAppRow;

const noRateLimit = (_req: unknown, _res: unknown, next: () => void) => next();

function testApp() {
  const a = express();
  a.use(express.json());
  a.use(express.urlencoded({ extended: true }));
  a.use('/oauth', createOAuthRouter());
  a.use('/api/v1', createV1Router({ bearerAuth, rateLimit: noRateLimit, identity: identityAdapter, documents: documentsAdapter, issues: issuesAdapter, sprints: sprintsAdapter, webhooks: stubWebhooks, audit: stubAudit }));
  return a;
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('HTTP Test WS') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const u = await pool.query(
    `INSERT INTO users (email, name) VALUES ('http-test@example.com', 'HTTP Tester') RETURNING id`,
  );
  userId = u.rows[0].id;
  app = await store.createApp({
    clientId: 'ship_app_http', clientSecretHash: await hashClientSecret(SECRET), name: 'HTTP App',
    redirectUris: ['https://app.example.com/cb'],
    requestedScopes: ['documents:read'], appType: 'confidential', ownerUserId: userId, workspaceId,
  });
});

describe('POST /oauth/token (authorization_code)', () => {
  it('exchanges code+verifier+client_secret for a usable token, then GET /api/v1/me works', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await service.issueAuthorizationCode({
      app, userId, workspaceId, redirectUri: 'https://app.example.com/cb',
      scopes: ['documents:read'], codeChallenge: challenge, codeChallengeMethod: 'S256',
    });
    const a = testApp();
    const tokenRes = await request(a).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: 'https://app.example.com/cb',
      code_verifier: verifier, client_id: 'ship_app_http', client_secret: SECRET,
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.token_type).toBe('Bearer');
    expect(tokenRes.headers['cache-control']).toContain('no-store');
    const accessToken = tokenRes.body.access_token as string;

    const meRes = await request(a).get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user).toMatchObject({ id: userId, email: 'http-test@example.com' });
    expect(meRes.body.scopes).toEqual(['documents:read']);
  });

  it('returns RFC invalid_grant on a wrong code_verifier', async () => {
    const { challenge } = pkcePair();
    const code = await service.issueAuthorizationCode({
      app, userId, workspaceId, redirectUri: 'https://app.example.com/cb',
      scopes: ['documents:read'], codeChallenge: challenge, codeChallengeMethod: 'S256',
    });
    const res = await request(testApp()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code, redirect_uri: 'https://app.example.com/cb',
      code_verifier: 'wrong', client_id: 'ship_app_http', client_secret: SECRET,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('returns invalid_client on a bad client_secret', async () => {
    const res = await request(testApp()).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', code: 'x', redirect_uri: 'https://app.example.com/cb',
      code_verifier: 'y', client_id: 'ship_app_http', client_secret: 'nope',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  it('rejects an unsupported grant_type', async () => {
    const res = await request(testApp()).post('/oauth/token').type('form').send({ grant_type: 'password' });
    expect(res.body.error).toBe('unsupported_grant_type');
  });
});

describe('bearer middleware on /api/v1', () => {
  it('401 + token_missing when no Authorization header', async () => {
    const res = await request(testApp()).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'unauthorized' });
    expect(res.body.details?.reason).toBe('token_missing');
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });

  it('401 + token_invalid for a bogus token', async () => {
    const res = await request(testApp()).get('/api/v1/me').set('Authorization', 'Bearer ship_at_nope');
    expect(res.status).toBe(401);
    expect(res.body.details?.reason).toBe('token_invalid');
  });

  it('401 + token_expired (distinct) for an expired token', async () => {
    const raw = generate.accessToken();
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, app_id, user_id, workspace_id, scopes, grant_type, expires_at)
       VALUES ($1,$2,$3,$4,$5,'authorization_code', now() - interval '1 hour')`,
      [sha256(raw), app.id, userId, workspaceId, ['documents:read']],
    );
    const res = await request(testApp()).get('/api/v1/me').set('Authorization', `Bearer ${raw}`);
    expect(res.status).toBe(401);
    expect(res.body.details?.reason).toBe('token_expired');
  });
});
