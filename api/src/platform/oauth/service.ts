/**
 * OAuth 2.0 grant logic (RFC 6749 + 7636 + 8628). Pure-ish service functions the
 * routes call; each throws an {@link OAuthError} on the RFC failure path.
 *
 * Flows:
 *  - authorization_code + PKCE  (web apps / browser SPA)
 *  - refresh_token              (one-time-use, rotating; reuse ⇒ family revoke)
 *  - client_credentials         (first-party machine-to-machine — the agent)
 *  - device_code                (RFC 8628 — the CLI; slow_down honored)
 */
import { randomUUID } from 'crypto';
import { OAuthError } from './errors.js';
import { scopeRegistry } from '../scopes/registry.js';
import {
  sha256,
  generate,
  generateUserCode,
  verifyClientSecret,
  verifyPkce,
} from './crypto.js';
import * as store from './store.js';
import type { OAuthAppRow } from './store.js';

/** Token lifetimes. Access tokens are short-lived; refresh tokens rotate. */
export const TTL = {
  accessSec: 60 * 60, // 1 hour
  refreshSec: 30 * 24 * 60 * 60, // 30 days
  authCodeSec: 10 * 60, // 10 minutes
  deviceSec: 10 * 60, // 10 minutes
  deviceIntervalSec: 5,
} as const;

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

/** Validate requested scopes: each must be registered AND allowed for the app. */
export function resolveScopes(app: OAuthAppRow, requested: string[] | undefined): string[] {
  // Default to the app's full requested_scopes when the client asks for none.
  const want = requested && requested.length > 0 ? requested : app.requested_scopes;
  for (const s of want) {
    if (!scopeRegistry.has(s)) throw new OAuthError('invalid_scope', `Unknown scope: ${s}`);
    if (!app.requested_scopes.includes(s)) {
      throw new OAuthError('invalid_scope', `App is not allowed scope: ${s}`);
    }
  }
  return want;
}

/**
 * Authenticate the client at the token endpoint. Confidential / first-party apps
 * MUST present a valid secret. Public apps (PKCE) may omit it.
 */
export async function authenticateClient(
  clientId: string | undefined,
  clientSecret: string | undefined,
): Promise<OAuthAppRow> {
  if (!clientId) throw new OAuthError('invalid_client', 'client_id is required');
  const app = await store.getAppByClientId(clientId);
  if (!app) throw new OAuthError('invalid_client', 'Unknown or inactive client');

  if (app.app_type === 'public') {
    // Public client: secret optional; if supplied, it must still match.
    if (clientSecret && !(await verifyClientSecret(clientSecret, app.client_secret_hash))) {
      throw new OAuthError('invalid_client', 'Invalid client credentials');
    }
    return app;
  }
  // Confidential / first_party: secret required.
  if (!clientSecret || !(await verifyClientSecret(clientSecret, app.client_secret_hash))) {
    throw new OAuthError('invalid_client', 'Invalid client credentials');
  }
  return app;
}

async function mintTokens(input: {
  app: OAuthAppRow;
  userId: string | null;
  workspaceId: string | null;
  scopes: string[];
  grantType: 'authorization_code' | 'refresh_token' | 'client_credentials' | 'device_code';
  withRefresh: boolean;
  familyId?: string;
}): Promise<TokenResponse> {
  const accessRaw = generate.accessToken();
  await store.insertAccessToken({
    tokenHash: sha256(accessRaw),
    appId: input.app.id,
    userId: input.userId,
    workspaceId: input.workspaceId,
    scopes: input.scopes,
    grantType: input.grantType,
    expiresAt: new Date(Date.now() + TTL.accessSec * 1000),
  });

  let refreshRaw: string | undefined;
  if (input.withRefresh && input.userId) {
    refreshRaw = generate.refreshToken();
    await store.insertRefreshToken({
      tokenHash: sha256(refreshRaw),
      appId: input.app.id,
      userId: input.userId,
      workspaceId: input.workspaceId,
      scopes: input.scopes,
      familyId: input.familyId ?? randomUUID(),
      expiresAt: new Date(Date.now() + TTL.refreshSec * 1000),
    });
  }

  return {
    access_token: accessRaw,
    token_type: 'Bearer',
    expires_in: TTL.accessSec,
    ...(refreshRaw ? { refresh_token: refreshRaw } : {}),
    scope: input.scopes.join(' '),
  };
}

// ---- authorization code (issuance happens at /oauth/authorize consent) ----

/** Issue an authorization code after the user consents. Returns the raw code. */
export async function issueAuthorizationCode(input: {
  app: OAuthAppRow;
  userId: string;
  workspaceId: string | null;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: 'S256' | 'plain';
}): Promise<string> {
  const code = generate.authorizationCode();
  await store.insertAuthCode({
    codeHash: sha256(code),
    appId: input.app.id,
    userId: input.userId,
    workspaceId: input.workspaceId,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    codeChallenge: input.codeChallenge,
    method: input.codeChallengeMethod,
    expiresAt: new Date(Date.now() + TTL.authCodeSec * 1000),
  });
  return code;
}

/** grant_type=authorization_code — exchange code + PKCE verifier for tokens. */
export async function exchangeAuthorizationCode(input: {
  app: OAuthAppRow;
  code: string;
  redirectUri: string;
  codeVerifier: string | undefined;
}): Promise<TokenResponse> {
  const row = await store.getAuthCodeByHash(sha256(input.code));
  if (!row) throw new OAuthError('invalid_grant', 'Invalid authorization code');
  if (row.app_id !== input.app.id) throw new OAuthError('invalid_grant', 'Code was issued to a different client');
  if (row.consumed_at) throw new OAuthError('invalid_grant', 'Authorization code already used');
  if (new Date(row.expires_at).getTime() < Date.now()) throw new OAuthError('invalid_grant', 'Authorization code expired');
  if (row.redirect_uri !== input.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri mismatch');

  // PKCE: the mandatory negative case. A wrong verifier MUST fail with invalid_grant.
  if (!input.codeVerifier) throw new OAuthError('invalid_grant', 'code_verifier is required');
  if (!verifyPkce(input.codeVerifier, row.code_challenge, row.code_challenge_method)) {
    throw new OAuthError('invalid_grant', 'PKCE verification failed');
  }

  await store.consumeAuthCode(row.id);
  return mintTokens({
    app: input.app,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    scopes: row.scopes,
    grantType: 'authorization_code',
    withRefresh: true,
  });
}

// ---- refresh token rotation -----------------------------------------------

/** grant_type=refresh_token — rotate. Reuse of a consumed token revokes the family. */
export async function refresh(input: {
  app: OAuthAppRow;
  refreshToken: string;
  requestedScopes?: string[];
}): Promise<TokenResponse> {
  const row = await store.getRefreshTokenByHash(sha256(input.refreshToken));
  if (!row) throw new OAuthError('invalid_grant', 'Invalid refresh token');
  if (row.app_id !== input.app.id) throw new OAuthError('invalid_grant', 'Refresh token belongs to a different client');
  if (row.revoked_at) throw new OAuthError('invalid_grant', 'Refresh token has been revoked');

  // THEFT DETECTION: a consumed (already-rotated) token presented again means the
  // token was captured. Revoke the entire family and reject. (The marquee drill.)
  if (row.consumed_at) {
    await store.revokeRefreshFamily(row.family_id);
    throw new OAuthError('invalid_grant', 'Refresh token reuse detected — token family revoked');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) throw new OAuthError('invalid_grant', 'Refresh token expired');

  // Scopes may narrow on refresh, never widen.
  let scopes = row.scopes;
  if (input.requestedScopes && input.requestedScopes.length > 0) {
    for (const s of input.requestedScopes) {
      if (!row.scopes.includes(s)) throw new OAuthError('invalid_scope', `Cannot widen scope on refresh: ${s}`);
    }
    scopes = input.requestedScopes;
  }

  // Mint the new pair in the SAME family, then mark the old one consumed.
  const next = await mintTokens({
    app: input.app,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    scopes,
    grantType: 'refresh_token',
    withRefresh: true,
    familyId: row.family_id,
  });

  // Find the freshly-minted refresh token id to record the rotation link.
  const newHash = sha256(next.refresh_token!);
  const newRow = await store.getRefreshTokenByHash(newHash);
  await store.consumeRefreshToken(row.id, newRow!.id);
  return next;
}

// ---- client credentials (first-party M2M — the agent) ---------------------

/** grant_type=client_credentials — no user, no refresh token (RFC 6749 §4.4.3). */
export async function clientCredentials(input: {
  app: OAuthAppRow;
  requestedScopes?: string[];
}): Promise<TokenResponse> {
  if (input.app.app_type === 'public') {
    throw new OAuthError('unauthorized_client', 'Public clients cannot use client_credentials');
  }
  const scopes = resolveScopes(input.app, input.requestedScopes);
  return mintTokens({
    app: input.app,
    userId: null,
    workspaceId: input.app.workspace_id,
    scopes,
    grantType: 'client_credentials',
    withRefresh: false,
  });
}

// ---- device authorization grant (RFC 8628) --------------------------------

export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** Start a device flow: returns device_code + user_code (raw). */
export async function startDeviceAuthorization(input: {
  app: OAuthAppRow;
  requestedScopes?: string[];
  verificationBaseUrl: string;
}): Promise<DeviceAuthResponse> {
  const scopes = resolveScopes(input.app, input.requestedScopes);
  const deviceCode = generate.deviceCode();
  const userCode = generateUserCode();
  await store.insertDeviceCode({
    deviceCodeHash: sha256(deviceCode),
    userCode,
    appId: input.app.id,
    scopes,
    intervalSec: TTL.deviceIntervalSec,
    expiresAt: new Date(Date.now() + TTL.deviceSec * 1000),
  });
  const verificationUri = `${input.verificationBaseUrl}/oauth/device`;
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
    expires_in: TTL.deviceSec,
    interval: TTL.deviceIntervalSec,
  };
}

/** grant_type=device_code — poll endpoint. Honors slow_down / authorization_pending. */
export async function pollDeviceToken(input: {
  app: OAuthAppRow;
  deviceCode: string;
}): Promise<TokenResponse> {
  const row = await store.getDeviceByHash(sha256(input.deviceCode));
  if (!row || row.app_id !== input.app.id) throw new OAuthError('invalid_grant', 'Unknown device_code');
  if (new Date(row.expires_at).getTime() < Date.now()) throw new OAuthError('expired_token', 'Device code expired');

  // slow_down: reject polls faster than the advertised interval (RFC 8628 §3.5).
  if (row.last_polled_at) {
    const since = Date.now() - new Date(row.last_polled_at).getTime();
    if (since < row.interval_sec * 1000) {
      await store.touchDevicePoll(row.id);
      throw new OAuthError('slow_down', `Polling too fast; wait ${row.interval_sec}s`);
    }
  }
  await store.touchDevicePoll(row.id);

  if (row.status === 'denied') throw new OAuthError('access_denied', 'User denied the request');
  if (row.status === 'pending') throw new OAuthError('authorization_pending', 'Waiting for user approval');

  // approved → mint tokens once, then delete the device code (single use).
  const tokens = await mintTokens({
    app: input.app,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    scopes: row.scopes,
    grantType: 'device_code',
    withRefresh: true,
  });
  await store.deleteDeviceCode(row.id);
  return tokens;
}
