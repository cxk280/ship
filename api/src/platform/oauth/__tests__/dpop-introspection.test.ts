/**
 * B12 — DPoP sender-constrained tokens (RFC 9449) + token introspection (RFC 7662).
 *
 * Covers the graded server surface end-to-end over HTTP:
 *  - DPoP happy path: proof at /oauth/token → DPoP-bound token (token_type "DPoP",
 *    jkt persisted) → /api/v1/me with a matching proof succeeds.
 *  - A DPoP-bound token presented as plain Bearer → 401 (the whole point).
 *  - DPoP proof failures (wrong htu/htm, wrong key, stale iat, replayed jti) → 401.
 *  - Plain Bearer (no DPoP) still works (regression).
 *  - Introspection: active bearer, expired/revoked/garbage, DPoP cnf.jkt, bad client.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { pool } from '../../../db/client.js';
import * as store from '../store.js';
import { hashClientSecret, sha256, generate } from '../crypto.js';
import { createOAuthRouter } from '../routes.js';
import { createV1Router } from '../../api/v1/router.js';
import { bearerAuth } from '../bearer.js';
import { jwkThumbprint } from '../dpop.js';
import { identityAdapter } from '../../adapters/identity.js';
import { createDocumentsAdapter } from '../../adapters/documents.js';
import { createIssuesAdapter } from '../../adapters/issues.js';
import { createSprintsAdapter } from '../../adapters/sprints.js';
import { stubWebhooks, stubAudit, stubIdempotency, noopBus } from '../../webhooks/__tests__/test-doubles.js';

const documentsAdapter = createDocumentsAdapter(noopBus);
const issuesAdapter = createIssuesAdapter(noopBus);
const sprintsAdapter = createSprintsAdapter();

const SECRET = 'ship_secret_dpop_known';
let workspaceId: string;
let userId: string;
let app: store.OAuthAppRow;

const noRateLimit = (_req: unknown, _res: unknown, next: () => void) => next();

function testApp() {
  const a = express();
  // Force a stable host so DPoP htu reconstruction is deterministic in tests.
  a.use((req, _res, next) => {
    req.headers.host = 'api.test';
    next();
  });
  a.use(express.json());
  a.use(express.urlencoded({ extended: true }));
  a.use('/oauth', createOAuthRouter());
  a.use('/api/v1', createV1Router({ bearerAuth, rateLimit: noRateLimit, identity: identityAdapter, documents: documentsAdapter, issues: issuesAdapter, sprints: sprintsAdapter, webhooks: stubWebhooks, audit: stubAudit, idempotency: stubIdempotency }));
  return a;
}

const ORIGIN = 'http://api.test';

// ---- in-test DPoP keypair + proof factory (node:crypto only) ----------------

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface TestKey {
  privateKey: crypto.KeyObject;
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}

function makeKey(): TestKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  return { privateKey, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}

function makeProof(
  key: TestKey,
  htm: string,
  htu: string,
  opts: { iat?: number; jti?: string; accessToken?: string; alg?: string } = {},
): string {
  const header = { typ: 'dpop+jwt', alg: opts.alg ?? 'ES256', jwk: key.jwk };
  const payload: Record<string, unknown> = {
    jti: opts.jti ?? crypto.randomUUID(),
    htm,
    htu,
    iat: opts.iat ?? Math.floor(Date.now() / 1000),
  };
  if (opts.accessToken !== undefined) {
    payload.ath = b64url(crypto.createHash('sha256').update(opts.accessToken).digest());
  }
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  sign.end();
  const sig = sign.sign({ key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(sig)}`;
}

/** Mint a DPoP-bound client_credentials token via the real /oauth/token endpoint. */
async function mintDpopToken(a: express.Express, key: TestKey) {
  const proof = makeProof(key, 'POST', `${ORIGIN}/oauth/token`);
  const res = await request(a)
    .post('/oauth/token')
    .type('form')
    .set('DPoP', proof)
    .send({ grant_type: 'client_credentials', client_id: app.client_id, client_secret: SECRET });
  return res;
}

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('DPoP Test WS') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const u = await pool.query(
    `INSERT INTO users (email, name) VALUES ('dpop-test@example.com', 'DPoP Tester') RETURNING id`,
  );
  userId = u.rows[0].id;
  app = await store.createApp({
    clientId: 'ship_app_dpop',
    clientSecretHash: await hashClientSecret(SECRET),
    name: 'DPoP App',
    redirectUris: ['https://app.example.com/cb'],
    requestedScopes: ['documents:read'],
    appType: 'first_party',
    ownerUserId: userId,
    workspaceId,
  });
});

describe('DPoP token issuance + binding (RFC 9449)', () => {
  it('happy path: proof → DPoP-bound token (token_type DPoP, jkt persisted) → API call with matching proof succeeds', async () => {
    const a = testApp();
    const key = makeKey();
    const tokenRes = await mintDpopToken(a, key);
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.token_type).toBe('DPoP');
    const accessToken = tokenRes.body.access_token as string;

    // jkt persisted on the token, equals the key's RFC 7638 thumbprint.
    const expectedJkt = jwkThumbprint(key.jwk);
    const row = await pool.query('SELECT dpop_jkt FROM oauth_access_tokens WHERE token_hash = $1', [sha256(accessToken)]);
    expect(row.rows[0].dpop_jkt).toBe(expectedJkt);

    // Resource request with the DPoP scheme + a fresh, matching proof succeeds.
    const apiProof = makeProof(key, 'GET', `${ORIGIN}/api/v1/me`, { accessToken });
    const meRes = await request(a)
      .get('/api/v1/me')
      .set('Authorization', `DPoP ${accessToken}`)
      .set('DPoP', apiProof);
    expect(meRes.status).toBe(200);
  });

  it('rejects a DPoP-bound token presented as plain Bearer (401)', async () => {
    const a = testApp();
    const key = makeKey();
    const tokenRes = await mintDpopToken(a, key);
    const accessToken = tokenRes.body.access_token as string;

    const res = await request(a).get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
    expect(res.body.details?.reason).toBe('token_invalid');
    expect(res.headers['www-authenticate']).toContain('DPoP');
  });

  it('rejects the DPoP scheme with no proof header (401)', async () => {
    const a = testApp();
    const key = makeKey();
    const accessToken = (await mintDpopToken(a, key)).body.access_token as string;
    const res = await request(a).get('/api/v1/me').set('Authorization', `DPoP ${accessToken}`);
    expect(res.status).toBe(401);
  });

  it('rejects a proof with the wrong htu (401)', async () => {
    const a = testApp();
    const key = makeKey();
    const accessToken = (await mintDpopToken(a, key)).body.access_token as string;
    const badProof = makeProof(key, 'GET', `${ORIGIN}/api/v1/elsewhere`, { accessToken });
    const res = await request(a).get('/api/v1/me').set('Authorization', `DPoP ${accessToken}`).set('DPoP', badProof);
    expect(res.status).toBe(401);
  });

  it('rejects a proof with the wrong htm (401)', async () => {
    const a = testApp();
    const key = makeKey();
    const accessToken = (await mintDpopToken(a, key)).body.access_token as string;
    const badProof = makeProof(key, 'POST', `${ORIGIN}/api/v1/me`, { accessToken });
    const res = await request(a).get('/api/v1/me').set('Authorization', `DPoP ${accessToken}`).set('DPoP', badProof);
    expect(res.status).toBe(401);
  });

  it('rejects a proof signed by the wrong key (401)', async () => {
    const a = testApp();
    const key = makeKey();
    const accessToken = (await mintDpopToken(a, key)).body.access_token as string;
    const attacker = makeKey();
    const badProof = makeProof(attacker, 'GET', `${ORIGIN}/api/v1/me`, { accessToken });
    const res = await request(a).get('/api/v1/me').set('Authorization', `DPoP ${accessToken}`).set('DPoP', badProof);
    expect(res.status).toBe(401);
  });

  it('rejects a stale proof (iat too old) (401)', async () => {
    const a = testApp();
    const key = makeKey();
    const accessToken = (await mintDpopToken(a, key)).body.access_token as string;
    const staleIat = Math.floor(Date.now() / 1000) - 10_000;
    const staleProof = makeProof(key, 'GET', `${ORIGIN}/api/v1/me`, { accessToken, iat: staleIat });
    const res = await request(a).get('/api/v1/me').set('Authorization', `DPoP ${accessToken}`).set('DPoP', staleProof);
    expect(res.status).toBe(401);
  });

  it('rejects a replayed jti (same proof used twice) (401)', async () => {
    const a = testApp();
    const key = makeKey();
    const accessToken = (await mintDpopToken(a, key)).body.access_token as string;
    const proof = makeProof(key, 'GET', `${ORIGIN}/api/v1/me`, { accessToken });
    const first = await request(a).get('/api/v1/me').set('Authorization', `DPoP ${accessToken}`).set('DPoP', proof);
    expect(first.status).toBe(200);
    const second = await request(a).get('/api/v1/me').set('Authorization', `DPoP ${accessToken}`).set('DPoP', proof);
    expect(second.status).toBe(401);
  });

  it('rejects a malformed DPoP proof at the token endpoint (invalid_dpop_proof)', async () => {
    const a = testApp();
    const res = await request(a)
      .post('/oauth/token')
      .type('form')
      .set('DPoP', 'not-a-jwt')
      .send({ grant_type: 'client_credentials', client_id: app.client_id, client_secret: SECRET });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_dpop_proof');
  });
});

describe('plain Bearer regression (DPoP is additive)', () => {
  it('a non-DPoP client_credentials token still works as plain Bearer', async () => {
    const a = testApp();
    const tokenRes = await request(a)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'client_credentials', client_id: app.client_id, client_secret: SECRET });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.token_type).toBe('Bearer');
    const accessToken = tokenRes.body.access_token as string;

    const row = await pool.query('SELECT dpop_jkt FROM oauth_access_tokens WHERE token_hash = $1', [sha256(accessToken)]);
    expect(row.rows[0].dpop_jkt).toBeNull();

    const meRes = await request(a).get('/api/v1/me').set('Authorization', `Bearer ${accessToken}`);
    expect(meRes.status).toBe(200);
  });
});

describe('Token introspection (RFC 7662)', () => {
  async function introspect(a: express.Express, token: string, creds = { client_id: app.client_id, client_secret: SECRET }) {
    return request(a).post('/oauth/introspect').type('form').send({ token, ...creds });
  }

  it('active access token → active:true with the expected fields', async () => {
    const a = testApp();
    const tokenRes = await request(a)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'client_credentials', client_id: app.client_id, client_secret: SECRET });
    const accessToken = tokenRes.body.access_token as string;

    const res = await introspect(a, accessToken);
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(res.body.client_id).toBe(app.client_id);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.scope).toBe('documents:read');
    expect(typeof res.body.exp).toBe('number');
    expect(res.body.cnf).toBeUndefined();
  });

  it('DPoP-bound token → cnf.jkt present and token_type DPoP', async () => {
    const a = testApp();
    const key = makeKey();
    const accessToken = (await mintDpopToken(a, key)).body.access_token as string;
    const res = await introspect(a, accessToken);
    expect(res.body.active).toBe(true);
    expect(res.body.token_type).toBe('DPoP');
    expect(res.body.cnf?.jkt).toBe(jwkThumbprint(key.jwk));
  });

  it('garbage token → active:false (no leak)', async () => {
    const res = await introspect(testApp(), 'ship_at_totally_bogus');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it('expired token → active:false', async () => {
    const a = testApp();
    const raw = generate.accessToken();
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, app_id, user_id, workspace_id, scopes, grant_type, expires_at)
       VALUES ($1,$2,$3,$4,$5,'client_credentials', now() - interval '1 hour')`,
      [sha256(raw), app.id, null, workspaceId, ['documents:read']],
    );
    const res = await introspect(a, raw);
    expect(res.body).toEqual({ active: false });
  });

  it('revoked token → active:false', async () => {
    const a = testApp();
    const raw = generate.accessToken();
    await pool.query(
      `INSERT INTO oauth_access_tokens (token_hash, app_id, user_id, workspace_id, scopes, grant_type, expires_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,'client_credentials', now() + interval '1 hour', now())`,
      [sha256(raw), app.id, null, workspaceId, ['documents:read']],
    );
    const res = await introspect(a, raw);
    expect(res.body).toEqual({ active: false });
  });

  it('wrong client auth → 401 invalid_client', async () => {
    const a = testApp();
    const tokenRes = await request(a)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'client_credentials', client_id: app.client_id, client_secret: SECRET });
    const accessToken = tokenRes.body.access_token as string;
    const res = await introspect(a, accessToken, { client_id: app.client_id, client_secret: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });
});
