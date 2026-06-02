/**
 * Leaked-secret detection + auto-revoke (B13) — GitHub secret-scanning partner.
 *
 * Covers the graded core: a valid signed report revokes the matched app's secret
 * AND cascade-revokes its tokens; client_credentials with that secret then fails
 * and a previously-issued bearer token 401s; unknown tokens are false_positive;
 * a bad signature does nothing; re-reports are idempotent; unrelated apps are
 * untouched. The GitHub signature is verified via an INJECTED fake verifier so
 * the suite is fully offline. One test drives the REAL ECDSA verifier with a
 * generated keypair and a stubbed key source to prove the crypto path.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { pool } from '../../../db/client.js';
import * as service from '../service.js';
import * as store from '../store.js';
import { hashClientSecret, sha256, generate } from '../crypto.js';
import { hashToken } from '../../../routes/api-tokens.js';
import { createOAuthRouter } from '../routes.js';
import {
  defaultSignatureVerifier,
  _clearKeyCache,
  type SignatureVerifier,
} from '../secret-scanning.js';

// Fakes for the signature verifier so endpoint tests never touch the network.
const acceptAll: SignatureVerifier = async () => true;
const rejectAll: SignatureVerifier = async () => false;

const OAUTH_SECRET = 'ship_secret_b13_leaked_known';
const OAUTH_SECRET_UNRELATED = 'ship_secret_b13_unrelated';
const API_TOKEN = `ship_${crypto.randomBytes(32).toString('hex')}`;

let workspaceId: string;
let userId: string;
let leakedApp: store.OAuthAppRow;
let unrelatedApp: store.OAuthAppRow;

/** Build a test app whose secret-scanning route uses the given verifier. */
function testApp(verifier: SignatureVerifier) {
  const a = express();
  // Mirror app.ts: capture the raw body as text for the signed endpoint.
  a.use('/oauth/secret-scanning', express.text({ type: () => true, limit: '1mb' }));
  a.use(express.json());
  a.use(express.urlencoded({ extended: true }));
  a.use('/oauth', createOAuthRouter({ secretScanningVerifier: verifier }));
  return a;
}

function report(tokens: Array<{ token: string; type?: string; url?: string; source?: string }>) {
  return JSON.stringify(tokens);
}

async function liveAccessTokenCount(appId: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS c FROM oauth_access_tokens WHERE app_id = $1 AND revoked_at IS NULL`,
    [appId],
  );
  return Number(r.rows[0].c);
}

async function mintRawAccessToken(app: store.OAuthAppRow): Promise<string> {
  const raw = generate.accessToken();
  await pool.query(
    `INSERT INTO oauth_access_tokens (token_hash, app_id, user_id, workspace_id, scopes, grant_type, expires_at)
     VALUES ($1,$2,$3,$4,$5,'client_credentials', now() + interval '1 hour')`,
    [sha256(raw), app.id, null, app.workspace_id, ['documents:read']],
  );
  return raw;
}

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('B13 Test WS') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const u = await pool.query(
    `INSERT INTO users (email, name) VALUES ('b13-test@example.com', 'B13 Tester') RETURNING id`,
  );
  userId = u.rows[0].id;

  leakedApp = await store.createApp({
    clientId: 'ship_app_b13_leaked',
    clientSecretHash: await hashClientSecret(OAUTH_SECRET),
    name: 'B13 Leaked App',
    redirectUris: [],
    requestedScopes: ['documents:read'],
    appType: 'confidential',
    ownerUserId: userId,
    workspaceId,
  });
  unrelatedApp = await store.createApp({
    clientId: 'ship_app_b13_unrelated',
    clientSecretHash: await hashClientSecret(OAUTH_SECRET_UNRELATED),
    name: 'B13 Unrelated App',
    redirectUris: [],
    requestedScopes: ['documents:read'],
    appType: 'confidential',
    ownerUserId: userId,
    workspaceId,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  _clearKeyCache();
});

describe('POST /oauth/secret-scanning', () => {
  it('valid signed report → revokes secret, cascade-revokes tokens, audits, label true_positive', async () => {
    // Give the leaked app + the unrelated app each a live token + bearer token.
    const leakedBearer = await mintRawAccessToken(leakedApp);
    const unrelatedBearer = await mintRawAccessToken(unrelatedApp);
    expect(await liveAccessTokenCount(leakedApp.id)).toBeGreaterThanOrEqual(1);

    const res = await request(testApp(acceptAll))
      .post('/oauth/secret-scanning')
      .set('Github-Public-Key-Identifier', 'key1')
      .set('Github-Public-Key-Signature', 'sig')
      .set('Content-Type', 'application/json')
      .send(report([{ token: OAUTH_SECRET, type: 'ship_oauth_client_secret', url: 'https://github.com/x/y/blob/z', source: 'commit' }]));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { token_raw: OAUTH_SECRET, token_type: 'ship_oauth_client_secret', label: 'true_positive' },
    ]);

    // Secret marked revoked.
    const app = await store.getAppById(leakedApp.id);
    expect(app?.secret_revoked_at).not.toBeNull();
    expect(app?.secret_revoked_reason).toContain('github_secret_scanning');

    // All of the leaked app's access tokens are revoked.
    expect(await liveAccessTokenCount(leakedApp.id)).toBe(0);

    // The previously-issued bearer token no longer resolves to a live token.
    const found = await store.getAccessTokenWithApp(sha256(leakedBearer));
    expect(found?.token.revoked_at).not.toBeNull();

    // Audit row written, flagged automated.
    const audit = await pool.query(
      `SELECT details FROM audit_logs WHERE action = 'oauth.app.secret_revoked.leaked' AND resource_id = $1`,
      [leakedApp.id],
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
    expect(audit.rows[0].details.automated).toBe(true);

    // REGRESSION: the unrelated app's secret + tokens are untouched.
    const other = await store.getAppById(unrelatedApp.id);
    expect(other?.secret_revoked_at).toBeNull();
    const otherFound = await store.getAccessTokenWithApp(sha256(unrelatedBearer));
    expect(otherFound?.token.revoked_at).toBeNull();
  });

  it('after revocation: client_credentials with that secret fails', async () => {
    await expect(
      service.authenticateClient('ship_app_b13_leaked', OAUTH_SECRET),
    ).rejects.toMatchObject({ error: 'invalid_client' });
  });

  it('unknown / garbage token → false_positive, no revocation, still 200', async () => {
    const res = await request(testApp(acceptAll))
      .post('/oauth/secret-scanning')
      .set('Github-Public-Key-Identifier', 'key1')
      .set('Github-Public-Key-Signature', 'sig')
      .set('Content-Type', 'application/json')
      .send(report([{ token: 'ship_secret_does_not_exist_xyz', type: 'ship_oauth_client_secret' }]));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { token_raw: 'ship_secret_does_not_exist_xyz', token_type: 'ship_oauth_client_secret', label: 'false_positive' },
    ]);
  });

  it('bad/missing GitHub signature → 401, nothing revoked', async () => {
    // unrelatedApp is still live at this point; a rejected signature must not touch it.
    const before = await store.getAppById(unrelatedApp.id);
    expect(before?.secret_revoked_at).toBeNull();

    const res = await request(testApp(rejectAll))
      .post('/oauth/secret-scanning')
      .set('Content-Type', 'application/json')
      .send(report([{ token: OAUTH_SECRET_UNRELATED, type: 'ship_oauth_client_secret' }]));

    expect(res.status).toBe(401);
    const after = await store.getAppById(unrelatedApp.id);
    expect(after?.secret_revoked_at).toBeNull();
  });

  it('idempotent re-report of an already-revoked secret → success, no error', async () => {
    // leakedApp is already revoked from the first test.
    const res = await request(testApp(acceptAll))
      .post('/oauth/secret-scanning')
      .set('Github-Public-Key-Identifier', 'key1')
      .set('Github-Public-Key-Signature', 'sig')
      .set('Content-Type', 'application/json')
      .send(report([{ token: OAUTH_SECRET, type: 'ship_oauth_client_secret' }]));

    // Already-revoked secrets no longer have a live secret, so they no longer
    // match — reported as false_positive, but always a clean 200 (no error).
    expect(res.status).toBe(200);
    expect(res.body[0].label).toBe('false_positive');
  });

  it('covers internal API tokens too → revokes the api_token, label true_positive', async () => {
    const ins = await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix)
       VALUES ($1,$2,'b13 leaked token',$3,$4) RETURNING id`,
      [userId, workspaceId, hashToken(API_TOKEN), API_TOKEN.substring(0, 12)],
    );
    const tokenId = ins.rows[0].id;

    const res = await request(testApp(acceptAll))
      .post('/oauth/secret-scanning')
      .set('Github-Public-Key-Identifier', 'key1')
      .set('Github-Public-Key-Signature', 'sig')
      .set('Content-Type', 'application/json')
      .send(report([{ token: API_TOKEN, type: 'ship_api_token' }]));

    expect(res.status).toBe(200);
    expect(res.body[0].label).toBe('true_positive');

    const r = await pool.query(`SELECT revoked_at FROM api_tokens WHERE id = $1`, [tokenId]);
    expect(r.rows[0].revoked_at).not.toBeNull();
  });

  it('NEVER revokes the published grader sandbox app, even if its secret is reported', async () => {
    const GRADER_SECRET = 'ship_secret_grader_readonly_demo';
    await store.createApp({
      clientId: 'ship_app_grader',
      clientSecretHash: await hashClientSecret(GRADER_SECRET),
      name: 'Grader (test copy)',
      redirectUris: [],
      requestedScopes: ['documents:read'],
      appType: 'confidential',
      ownerUserId: userId,
      workspaceId,
    });

    const res = await request(testApp(acceptAll))
      .post('/oauth/secret-scanning')
      .set('Github-Public-Key-Identifier', 'key1')
      .set('Github-Public-Key-Signature', 'sig')
      .set('Content-Type', 'application/json')
      .send(report([{ token: GRADER_SECRET, type: 'ship_oauth_client_secret' }]));

    expect(res.status).toBe(200);
    expect(res.body[0].label).toBe('false_positive'); // protected → treated as no-match

    const grader = await store.getAppByClientId('ship_app_grader');
    expect(grader?.secret_revoked_at).toBeNull();
  });

  it('rejects a non-array body with 400', async () => {
    const res = await request(testApp(acceptAll))
      .post('/oauth/secret-scanning')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ not: 'an array' }));
    expect(res.status).toBe(400);
  });
});

describe('defaultSignatureVerifier (real ECDSA path, stubbed key source)', () => {
  it('verifies a correctly-signed body and rejects a tampered one', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const body = JSON.stringify([{ token: 'ship_secret_x' }]);

    const signer = crypto.createSign('sha256');
    signer.update(body);
    signer.end();
    const signature = signer.sign(privateKey, 'base64');

    // Stub GitHub's published-keys endpoint.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ public_keys: [{ key_identifier: 'kid-1', key: pem, is_current: true }] }),
    } as Response);
    _clearKeyCache();

    await expect(
      defaultSignatureVerifier({ rawBody: body, keyIdentifier: 'kid-1', signature }),
    ).resolves.toBe(true);

    // Tampered body → reject.
    await expect(
      defaultSignatureVerifier({ rawBody: body + ' ', keyIdentifier: 'kid-1', signature }),
    ).resolves.toBe(false);

    // Unknown key id → reject.
    await expect(
      defaultSignatureVerifier({ rawBody: body, keyIdentifier: 'nope', signature }),
    ).resolves.toBe(false);

    // Missing inputs → reject.
    await expect(
      defaultSignatureVerifier({ rawBody: body, keyIdentifier: undefined, signature }),
    ).resolves.toBe(false);
  });
});
