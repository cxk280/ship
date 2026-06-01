/**
 * OAuth grant-logic integration tests (against ship_test).
 *
 * Covers the flows the MVP and PRD testing scenarios pin down — most importantly
 * the MANDATORY negative cases: wrong PKCE verifier ⇒ invalid_grant, and refresh
 * token reuse ⇒ family revocation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { pool } from '../../../db/client.js';
import * as service from '../service.js';
import * as store from '../store.js';
import { hashClientSecret, sha256 } from '../crypto.js';
import { OAuthError } from '../errors.js';

const SECRET = 'ship_secret_test_known';
let workspaceId: string;
let userId: string;
let confidentialApp: store.OAuthAppRow;
let publicApp: store.OAuthAppRow;

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('OAuth Test WS') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const u = await pool.query(
    `INSERT INTO users (email, name) VALUES ('oauth-test@example.com', 'OAuth Tester') RETURNING id`,
  );
  userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'admin')`,
    [workspaceId, userId],
  );
  const hash = await hashClientSecret(SECRET);
  confidentialApp = await store.createApp({
    clientId: 'ship_app_confidential', clientSecretHash: hash, name: 'Confidential App',
    redirectUris: ['https://app.example.com/callback'],
    requestedScopes: ['documents:read', 'documents:write'], appType: 'confidential',
    ownerUserId: userId, workspaceId,
  });
  publicApp = await store.createApp({
    clientId: 'ship_app_public', clientSecretHash: hash, name: 'Public SPA',
    redirectUris: ['https://spa.example.com/callback'],
    requestedScopes: ['documents:read'], appType: 'public',
    ownerUserId: userId, workspaceId,
  });
});

describe('authorization_code + PKCE', () => {
  it('exchanges a valid code+verifier for an access+refresh token', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await service.issueAuthorizationCode({
      app: publicApp, userId, workspaceId, redirectUri: 'https://spa.example.com/callback',
      scopes: ['documents:read'], codeChallenge: challenge, codeChallengeMethod: 'S256',
    });
    const tokens = await service.exchangeAuthorizationCode({
      app: publicApp, code, redirectUri: 'https://spa.example.com/callback', codeVerifier: verifier,
    });
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toMatch(/^ship_at_/);
    expect(tokens.refresh_token).toMatch(/^ship_rt_/);
    expect(tokens.scope).toBe('documents:read');
    // token is usable: it exists and is unexpired
    const found = await store.getAccessTokenWithApp(sha256(tokens.access_token));
    expect(found?.token.user_id).toBe(userId);
  });

  it('REJECTS a wrong code_verifier with invalid_grant (mandatory negative case)', async () => {
    const { challenge } = pkcePair();
    const code = await service.issueAuthorizationCode({
      app: publicApp, userId, workspaceId, redirectUri: 'https://spa.example.com/callback',
      scopes: ['documents:read'], codeChallenge: challenge, codeChallengeMethod: 'S256',
    });
    await expect(
      service.exchangeAuthorizationCode({
        app: publicApp, code, redirectUri: 'https://spa.example.com/callback',
        codeVerifier: 'totally-the-wrong-verifier',
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects reuse of a consumed code with invalid_grant', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await service.issueAuthorizationCode({
      app: publicApp, userId, workspaceId, redirectUri: 'https://spa.example.com/callback',
      scopes: ['documents:read'], codeChallenge: challenge, codeChallengeMethod: 'S256',
    });
    await service.exchangeAuthorizationCode({
      app: publicApp, code, redirectUri: 'https://spa.example.com/callback', codeVerifier: verifier,
    });
    await expect(
      service.exchangeAuthorizationCode({
        app: publicApp, code, redirectUri: 'https://spa.example.com/callback', codeVerifier: verifier,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects a redirect_uri mismatch with invalid_grant', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await service.issueAuthorizationCode({
      app: publicApp, userId, workspaceId, redirectUri: 'https://spa.example.com/callback',
      scopes: ['documents:read'], codeChallenge: challenge, codeChallengeMethod: 'S256',
    });
    await expect(
      service.exchangeAuthorizationCode({
        app: publicApp, code, redirectUri: 'https://evil.example.com/callback', codeVerifier: verifier,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });
});

describe('refresh_token rotation + theft detection', () => {
  async function freshRefresh(): Promise<string> {
    const { verifier, challenge } = pkcePair();
    const code = await service.issueAuthorizationCode({
      app: confidentialApp, userId, workspaceId, redirectUri: 'https://app.example.com/callback',
      scopes: ['documents:read'], codeChallenge: challenge, codeChallengeMethod: 'S256',
    });
    const t = await service.exchangeAuthorizationCode({
      app: confidentialApp, code, redirectUri: 'https://app.example.com/callback', codeVerifier: verifier,
    });
    return t.refresh_token!;
  }

  it('rotates: a refresh yields a NEW refresh token', async () => {
    const rt = await freshRefresh();
    const next = await service.refresh({ app: confidentialApp, refreshToken: rt });
    expect(next.refresh_token).toBeDefined();
    expect(next.refresh_token).not.toBe(rt);
  });

  it('reusing a CONSUMED refresh token revokes the whole family', async () => {
    const rt1 = await freshRefresh();
    const next = await service.refresh({ app: confidentialApp, refreshToken: rt1 });
    const rt2 = next.refresh_token!;
    // Replaying the spent rt1 is the theft signal.
    await expect(
      service.refresh({ app: confidentialApp, refreshToken: rt1 }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    // ...and the legitimately-rotated rt2 is now dead too (family revoked).
    await expect(
      service.refresh({ app: confidentialApp, refreshToken: rt2 }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });
});

describe('client_credentials (first-party M2M)', () => {
  it('issues an access token with NO refresh token and no user', async () => {
    const tokens = await service.clientCredentials({
      app: confidentialApp, requestedScopes: ['documents:read'],
    });
    expect(tokens.access_token).toMatch(/^ship_at_/);
    expect(tokens.refresh_token).toBeUndefined();
    const found = await store.getAccessTokenWithApp(sha256(tokens.access_token));
    expect(found?.token.user_id).toBeNull();
    expect(found?.token.grant_type).toBe('client_credentials');
  });

  it('rejects a public client using client_credentials', async () => {
    await expect(
      service.clientCredentials({ app: publicApp }),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it('rejects an unregistered or disallowed scope', async () => {
    await expect(
      service.clientCredentials({ app: confidentialApp, requestedScopes: ['issues:write'] }),
    ).rejects.toMatchObject({ error: 'invalid_scope' });
  });
});

describe('device authorization grant', () => {
  it('honors authorization_pending, slow_down, approval, and single-use', async () => {
    const start = await service.startDeviceAuthorization({
      app: confidentialApp, requestedScopes: ['documents:read'],
      verificationBaseUrl: 'https://ship.example.com',
    });
    expect(start.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // First poll: pending.
    await expect(
      service.pollDeviceToken({ app: confidentialApp, deviceCode: start.device_code }),
    ).rejects.toMatchObject({ error: 'authorization_pending' });

    // Immediate second poll: slow_down (faster than interval).
    await expect(
      service.pollDeviceToken({ app: confidentialApp, deviceCode: start.device_code }),
    ).rejects.toMatchObject({ error: 'slow_down' });

    // Approve as the user, then bypass the slow_down window for the test by
    // backdating last_polled_at, and poll → tokens.
    const device = await store.getDeviceByUserCode(start.user_code);
    await store.approveDevice(device!.id, userId, workspaceId, ['documents:read']);
    await pool.query(
      `UPDATE oauth_device_codes SET last_polled_at = now() - interval '10 seconds' WHERE id = $1`,
      [device!.id],
    );
    const tokens = await service.pollDeviceToken({ app: confidentialApp, deviceCode: start.device_code });
    expect(tokens.access_token).toMatch(/^ship_at_/);

    // Single-use: the device code is gone after issuance.
    await expect(
      service.pollDeviceToken({ app: confidentialApp, deviceCode: start.device_code }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });
});

describe('client authentication', () => {
  it('accepts a valid confidential secret and rejects a bad one', async () => {
    await expect(service.authenticateClient('ship_app_confidential', SECRET)).resolves.toMatchObject({
      client_id: 'ship_app_confidential',
    });
    await expect(service.authenticateClient('ship_app_confidential', 'wrong')).rejects.toMatchObject({
      error: 'invalid_client',
    });
  });

  it('allows a public client to omit the secret', async () => {
    await expect(service.authenticateClient('ship_app_public', undefined)).resolves.toMatchObject({
      client_id: 'ship_app_public',
    });
  });
});
