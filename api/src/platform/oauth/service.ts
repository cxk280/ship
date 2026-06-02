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
  /** "DPoP" when the access token is sender-constrained (RFC 9449), else "Bearer". */
  token_type: 'Bearer' | 'DPoP';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

/**
 * Optional DPoP binding for a token request (RFC 9449). When supplied, the issued
 * access token is sender-constrained to this JWK thumbprint and the response
 * token_type is "DPoP". The refresh token is NOT bound (it's redeemed at the
 * client-authenticated token endpoint, not the resource server).
 */
export interface DpopBinding {
  jkt: string;
}

const tokenTypeFor = (binding?: DpopBinding): 'Bearer' | 'DPoP' => (binding ? 'DPoP' : 'Bearer');

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
  dpop?: DpopBinding;
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
    dpopJkt: input.dpop?.jkt ?? null,
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
    token_type: tokenTypeFor(input.dpop),
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
  dpop?: DpopBinding;
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

  const accessRaw = generate.accessToken();
  const refreshRaw = generate.refreshToken();
  const consumed = await store.consumeAuthCodeAndMintTokens({
    authCodeId: row.id,
    accessToken: {
      tokenHash: sha256(accessRaw),
      appId: input.app.id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      scopes: row.scopes,
      grantType: 'authorization_code',
      expiresAt: new Date(Date.now() + TTL.accessSec * 1000),
      dpopJkt: input.dpop?.jkt ?? null,
    },
    refreshToken: {
      tokenHash: sha256(refreshRaw),
      appId: input.app.id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      scopes: row.scopes,
      familyId: randomUUID(),
      expiresAt: new Date(Date.now() + TTL.refreshSec * 1000),
    },
  });
  if (!consumed) throw new OAuthError('invalid_grant', 'Authorization code already used');

  return {
    access_token: accessRaw,
    token_type: tokenTypeFor(input.dpop),
    expires_in: TTL.accessSec,
    refresh_token: refreshRaw,
    scope: row.scopes.join(' '),
  };
}

// ---- refresh token rotation -----------------------------------------------

/** grant_type=refresh_token — rotate. Reuse of a consumed token revokes the family. */
export async function refresh(input: {
  app: OAuthAppRow;
  refreshToken: string;
  requestedScopes?: string[];
  dpop?: DpopBinding;
}): Promise<TokenResponse> {
  const row = await store.getRefreshTokenByHash(sha256(input.refreshToken));
  if (!row) throw new OAuthError('invalid_grant', 'Invalid refresh token');
  if (row.app_id !== input.app.id) throw new OAuthError('invalid_grant', 'Refresh token belongs to a different client');
  if (row.revoked_at) throw new OAuthError('invalid_grant', 'Refresh token has been revoked');

  // THEFT DETECTION (fast path): a consumed (already-rotated) token presented
  // again means the token was captured. Revoke the entire family and reject.
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

  // Atomically claim the old refresh token and mint its replacement in one
  // transaction. The row lock stays held until the replacement exists, so a
  // racing duplicate's family revoke cannot miss the freshly-issued token.
  const accessRaw = generate.accessToken();
  const refreshRaw = generate.refreshToken();
  const rotated = await store.rotateRefreshToken({
    oldRefreshTokenId: row.id,
    accessToken: {
      tokenHash: sha256(accessRaw),
      appId: input.app.id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      scopes,
      grantType: 'refresh_token',
      expiresAt: new Date(Date.now() + TTL.accessSec * 1000),
      dpopJkt: input.dpop?.jkt ?? null,
    },
    refreshToken: {
      tokenHash: sha256(refreshRaw),
      appId: input.app.id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      scopes,
      familyId: row.family_id,
      expiresAt: new Date(Date.now() + TTL.refreshSec * 1000),
    },
  });
  if (!rotated) {
    await store.revokeRefreshFamily(row.family_id);
    throw new OAuthError('invalid_grant', 'Refresh token reuse detected — token family revoked');
  }

  return {
    access_token: accessRaw,
    token_type: tokenTypeFor(input.dpop),
    expires_in: TTL.accessSec,
    refresh_token: refreshRaw,
    scope: scopes.join(' '),
  };
}

// ---- client credentials (first-party M2M — the agent) ---------------------

/** grant_type=client_credentials — no user, no refresh token (RFC 6749 §4.4.3). */
export async function clientCredentials(input: {
  app: OAuthAppRow;
  requestedScopes?: string[];
  dpop?: DpopBinding;
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
    dpop: input.dpop,
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
  dpop?: DpopBinding;
}): Promise<TokenResponse> {
  const row = await store.getDeviceByHash(sha256(input.deviceCode));
  if (!row || row.app_id !== input.app.id) throw new OAuthError('invalid_grant', 'Unknown device_code');
  if (new Date(row.expires_at).getTime() < Date.now()) throw new OAuthError('expired_token', 'Device code expired');

  if (row.status === 'denied') throw new OAuthError('access_denied', 'User denied the request');
  if (row.status === 'pending') {
    // slow_down: reject polls faster than the advertised interval (RFC 8628 §3.5).
    if (row.last_polled_at) {
      const since = Date.now() - new Date(row.last_polled_at).getTime();
      if (since < row.interval_sec * 1000) {
        await store.touchDevicePoll(row.id);
        throw new OAuthError('slow_down', `Polling too fast; wait ${row.interval_sec}s`);
      }
    }
    await store.touchDevicePoll(row.id);
    throw new OAuthError('authorization_pending', 'Waiting for user approval');
  }

  if (!row.user_id) throw new OAuthError('invalid_grant', 'Approved device code is missing a user');

  // approved → atomically claim/delete the device code and mint tokens once.
  const accessRaw = generate.accessToken();
  const refreshRaw = generate.refreshToken();
  const claimed = await store.claimDeviceCodeAndMintTokens({
    deviceCodeId: row.id,
    accessToken: {
      tokenHash: sha256(accessRaw),
      appId: input.app.id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      scopes: row.scopes,
      grantType: 'device_code',
      expiresAt: new Date(Date.now() + TTL.accessSec * 1000),
      dpopJkt: input.dpop?.jkt ?? null,
    },
    refreshToken: {
      tokenHash: sha256(refreshRaw),
      appId: input.app.id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      scopes: row.scopes,
      familyId: randomUUID(),
      expiresAt: new Date(Date.now() + TTL.refreshSec * 1000),
    },
  });
  if (!claimed) throw new OAuthError('invalid_grant', 'Device code already used');

  return {
    access_token: accessRaw,
    token_type: tokenTypeFor(input.dpop),
    expires_in: TTL.accessSec,
    refresh_token: refreshRaw,
    scope: row.scopes.join(' '),
  };
}

// ---- token introspection (RFC 7662) ---------------------------------------

/**
 * RFC 7662 introspection response. `active` is always present; every other
 * member is omitted for an inactive token so we never leak WHY it's inactive.
 */
export interface IntrospectionResponse {
  active: boolean;
  scope?: string;
  client_id?: string;
  token_type?: 'Bearer' | 'DPoP';
  exp?: number;
  iat?: number;
  sub?: string;
  aud?: string;
  /** RFC 9449 confirmation claim for a DPoP-bound token. */
  cnf?: { jkt: string };
}

const INACTIVE: IntrospectionResponse = { active: false };

const toEpoch = (ts: string | null | undefined): number | undefined =>
  ts ? Math.floor(new Date(ts).getTime() / 1000) : undefined;

/**
 * Introspect a token presented at /oauth/introspect. The CALLER must have
 * already authenticated the requesting client. We look the token up by its
 * sha256 hash (same as everywhere else), trying the access-token table first and
 * falling back to refresh tokens. Any expired / revoked / consumed / unknown
 * token — or one whose app is deactivated — returns `{ active: false }` with no
 * detail, per RFC 7662 §2.2.
 */
export async function introspect(token: string): Promise<IntrospectionResponse> {
  if (!token || typeof token !== 'string') return INACTIVE;
  const hash = sha256(token);

  const at = await store.getAccessTokenForIntrospection(hash);
  if (at) {
    const expired = new Date(at.expires_at).getTime() < Date.now();
    if (at.revoked_at || expired || !at.app_is_active) return INACTIVE;
    const resp: IntrospectionResponse = {
      active: true,
      scope: at.scopes.join(' '),
      client_id: at.client_id,
      token_type: at.dpop_jkt ? 'DPoP' : 'Bearer',
      exp: toEpoch(at.expires_at),
      iat: toEpoch(at.created_at),
      ...(at.user_id ? { sub: at.user_id } : {}),
      ...(at.workspace_id ? { aud: at.workspace_id } : {}),
      ...(at.dpop_jkt ? { cnf: { jkt: at.dpop_jkt } } : {}),
    };
    return resp;
  }

  const rt = await store.getRefreshTokenForIntrospection(hash);
  if (rt) {
    const expired = new Date(rt.expires_at).getTime() < Date.now();
    if (rt.revoked_at || rt.consumed_at || expired || !rt.app_is_active) return INACTIVE;
    return {
      active: true,
      scope: rt.scopes.join(' '),
      client_id: rt.client_id,
      token_type: 'Bearer',
      exp: toEpoch(rt.expires_at),
      iat: toEpoch(rt.created_at),
      sub: rt.user_id,
      ...(rt.workspace_id ? { aud: rt.workspace_id } : {}),
    };
  }

  return INACTIVE;
}
