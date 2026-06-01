/**
 * OAuth persistence. Thin async functions over the shared pg pool — the OAuth
 * server is platform glue (not under /api/v1), so it may use internal db/client.
 */
import { pool } from '../../db/client.js';

export interface OAuthAppRow {
  id: string;
  client_id: string;
  client_secret_hash: string;
  name: string;
  description: string | null;
  redirect_uris: string[];
  requested_scopes: string[];
  app_type: 'confidential' | 'public' | 'first_party';
  owner_user_id: string | null;
  workspace_id: string | null;
  is_active: boolean;
  secret_rotated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccessTokenRow {
  id: string;
  token_hash: string;
  app_id: string;
  user_id: string | null;
  workspace_id: string | null;
  scopes: string[];
  grant_type: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface RefreshTokenRow {
  id: string;
  token_hash: string;
  app_id: string;
  user_id: string;
  workspace_id: string | null;
  scopes: string[];
  family_id: string;
  replaced_by: string | null;
  consumed_at: string | null;
  revoked_at: string | null;
  expires_at: string;
}

export interface AuthCodeRow {
  id: string;
  code_hash: string;
  app_id: string;
  user_id: string;
  workspace_id: string | null;
  redirect_uri: string;
  scopes: string[];
  code_challenge: string;
  code_challenge_method: 'S256' | 'plain';
  expires_at: string;
  consumed_at: string | null;
}

export interface DeviceCodeRow {
  id: string;
  device_code_hash: string;
  user_code: string;
  app_id: string;
  user_id: string | null;
  workspace_id: string | null;
  scopes: string[];
  status: 'pending' | 'approved' | 'denied';
  interval_sec: number;
  last_polled_at: string | null;
  expires_at: string;
}

// ---- apps -----------------------------------------------------------------

export async function createApp(input: {
  clientId: string;
  clientSecretHash: string;
  name: string;
  description?: string | null;
  redirectUris: string[];
  requestedScopes: string[];
  appType: 'confidential' | 'public' | 'first_party';
  ownerUserId: string | null;
  workspaceId: string | null;
}): Promise<OAuthAppRow> {
  const r = await pool.query(
    `INSERT INTO oauth_apps
       (client_id, client_secret_hash, name, description, redirect_uris, requested_scopes, app_type, owner_user_id, workspace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      input.clientId, input.clientSecretHash, input.name, input.description ?? null,
      input.redirectUris, input.requestedScopes, input.appType, input.ownerUserId, input.workspaceId,
    ],
  );
  return r.rows[0] as OAuthAppRow;
}

export async function getAppByClientId(clientId: string): Promise<OAuthAppRow | null> {
  const r = await pool.query('SELECT * FROM oauth_apps WHERE client_id = $1 AND is_active = TRUE', [clientId]);
  return (r.rows[0] as OAuthAppRow) ?? null;
}

export async function getAppById(id: string): Promise<OAuthAppRow | null> {
  const r = await pool.query('SELECT * FROM oauth_apps WHERE id = $1', [id]);
  return (r.rows[0] as OAuthAppRow) ?? null;
}

export async function listAppsByOwner(ownerUserId: string): Promise<OAuthAppRow[]> {
  const r = await pool.query(
    'SELECT * FROM oauth_apps WHERE owner_user_id = $1 ORDER BY created_at DESC',
    [ownerUserId],
  );
  return r.rows as OAuthAppRow[];
}

export async function rotateAppSecret(id: string, newHash: string): Promise<void> {
  await pool.query(
    'UPDATE oauth_apps SET client_secret_hash = $2, secret_rotated_at = now(), updated_at = now() WHERE id = $1',
    [id, newHash],
  );
}

export async function deactivateApp(id: string): Promise<void> {
  await pool.query('UPDATE oauth_apps SET is_active = FALSE, updated_at = now() WHERE id = $1', [id]);
}

// ---- authorization codes --------------------------------------------------

export async function insertAuthCode(input: {
  codeHash: string;
  appId: string;
  userId: string;
  workspaceId: string | null;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  method: 'S256' | 'plain';
  expiresAt: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO oauth_authorization_codes
       (code_hash, app_id, user_id, workspace_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.codeHash, input.appId, input.userId, input.workspaceId, input.redirectUri,
     input.scopes, input.codeChallenge, input.method, input.expiresAt],
  );
}

export async function getAuthCodeByHash(codeHash: string): Promise<AuthCodeRow | null> {
  const r = await pool.query('SELECT * FROM oauth_authorization_codes WHERE code_hash = $1', [codeHash]);
  return (r.rows[0] as AuthCodeRow) ?? null;
}

export async function consumeAuthCode(id: string): Promise<void> {
  await pool.query('UPDATE oauth_authorization_codes SET consumed_at = now() WHERE id = $1', [id]);
}

// ---- access tokens --------------------------------------------------------

export async function insertAccessToken(input: {
  tokenHash: string;
  appId: string;
  userId: string | null;
  workspaceId: string | null;
  scopes: string[];
  grantType: string;
  expiresAt: Date;
}): Promise<AccessTokenRow> {
  const r = await pool.query(
    `INSERT INTO oauth_access_tokens (token_hash, app_id, user_id, workspace_id, scopes, grant_type, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.tokenHash, input.appId, input.userId, input.workspaceId, input.scopes, input.grantType, input.expiresAt],
  );
  return r.rows[0] as AccessTokenRow;
}

/** Bearer-middleware lookup: token row + the (active) app it belongs to. */
export async function getAccessTokenWithApp(tokenHash: string): Promise<
  { token: AccessTokenRow; app: Pick<OAuthAppRow, 'id' | 'client_id' | 'is_active'> } | null
> {
  const r = await pool.query(
    `SELECT t.*, a.client_id AS app_client_id, a.is_active AS app_is_active
     FROM oauth_access_tokens t JOIN oauth_apps a ON t.app_id = a.id
     WHERE t.token_hash = $1`,
    [tokenHash],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    token: row as AccessTokenRow,
    app: { id: row.app_id, client_id: row.app_client_id, is_active: row.app_is_active },
  };
}

export async function touchAccessToken(id: string): Promise<void> {
  await pool.query('UPDATE oauth_access_tokens SET last_used_at = now() WHERE id = $1', [id]);
}

// ---- refresh tokens -------------------------------------------------------

export async function insertRefreshToken(input: {
  tokenHash: string;
  appId: string;
  userId: string;
  workspaceId: string | null;
  scopes: string[];
  familyId: string;
  expiresAt: Date;
}): Promise<RefreshTokenRow> {
  const r = await pool.query(
    `INSERT INTO oauth_refresh_tokens (token_hash, app_id, user_id, workspace_id, scopes, family_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [input.tokenHash, input.appId, input.userId, input.workspaceId, input.scopes, input.familyId, input.expiresAt],
  );
  return r.rows[0] as RefreshTokenRow;
}

export async function getRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
  const r = await pool.query('SELECT * FROM oauth_refresh_tokens WHERE token_hash = $1', [tokenHash]);
  return (r.rows[0] as RefreshTokenRow) ?? null;
}

export async function consumeRefreshToken(id: string, replacedBy: string): Promise<void> {
  await pool.query(
    'UPDATE oauth_refresh_tokens SET consumed_at = now(), replaced_by = $2 WHERE id = $1',
    [id, replacedBy],
  );
}

/**
 * Atomically claim a refresh token for rotation: marks it consumed ONLY if it is
 * still unconsumed and unrevoked, returning true iff THIS call won the claim.
 * Two concurrent refreshes with the same token serialize on the row lock, so
 * exactly one wins — closing the read-check-then-consume race (one-time-use holds).
 */
export async function claimRefreshToken(id: string): Promise<boolean> {
  const r = await pool.query(
    `UPDATE oauth_refresh_tokens
       SET consumed_at = now()
     WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
     RETURNING id`,
    [id],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Best-effort bookkeeping: link a consumed token to its replacement. */
export async function setRefreshReplacedBy(id: string, replacedBy: string): Promise<void> {
  await pool.query('UPDATE oauth_refresh_tokens SET replaced_by = $2 WHERE id = $1', [id, replacedBy]);
}

/** Theft response: revoke every refresh token in the family. */
export async function revokeRefreshFamily(familyId: string): Promise<void> {
  await pool.query(
    'UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
    [familyId],
  );
}

// ---- device codes ---------------------------------------------------------

export async function insertDeviceCode(input: {
  deviceCodeHash: string;
  userCode: string;
  appId: string;
  scopes: string[];
  intervalSec: number;
  expiresAt: Date;
}): Promise<DeviceCodeRow> {
  const r = await pool.query(
    `INSERT INTO oauth_device_codes (device_code_hash, user_code, app_id, scopes, interval_sec, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.deviceCodeHash, input.userCode, input.appId, input.scopes, input.intervalSec, input.expiresAt],
  );
  return r.rows[0] as DeviceCodeRow;
}

export async function getDeviceByUserCode(userCode: string): Promise<DeviceCodeRow | null> {
  const r = await pool.query('SELECT * FROM oauth_device_codes WHERE user_code = $1', [userCode]);
  return (r.rows[0] as DeviceCodeRow) ?? null;
}

export async function getDeviceByHash(deviceCodeHash: string): Promise<DeviceCodeRow | null> {
  const r = await pool.query('SELECT * FROM oauth_device_codes WHERE device_code_hash = $1', [deviceCodeHash]);
  return (r.rows[0] as DeviceCodeRow) ?? null;
}

export async function approveDevice(id: string, userId: string, workspaceId: string | null, scopes: string[]): Promise<void> {
  await pool.query(
    `UPDATE oauth_device_codes SET status = 'approved', user_id = $2, workspace_id = $3, scopes = $4 WHERE id = $1`,
    [id, userId, workspaceId, scopes],
  );
}

export async function denyDevice(id: string): Promise<void> {
  await pool.query(`UPDATE oauth_device_codes SET status = 'denied' WHERE id = $1`, [id]);
}

export async function touchDevicePoll(id: string): Promise<void> {
  await pool.query('UPDATE oauth_device_codes SET last_polled_at = now() WHERE id = $1', [id]);
}

/** Single-use: remove the device code once tokens have been issued. */
export async function deleteDeviceCode(id: string): Promise<void> {
  await pool.query('DELETE FROM oauth_device_codes WHERE id = $1', [id]);
}
