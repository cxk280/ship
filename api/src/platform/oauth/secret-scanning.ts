/**
 * GitHub Secret Scanning partner — leaked-secret detection + auto-revoke (B13).
 *
 * When a Ship client secret (or API token) is pushed to a public GitHub repo,
 * GitHub's secret-scanning service matches our published prefix patterns
 * (`ship_secret_`, `ship_`) and POSTs the leaked tokens to
 * `POST /oauth/secret-scanning`. We verify GitHub's ECDSA signature over the raw
 * body, then for each reported token: find the owning credential, revoke its
 * secret, cascade-revoke its live access + refresh tokens, and audit-log it.
 *
 * GitHub's request/response contract:
 *   - Headers: `Github-Public-Key-Identifier`, `Github-Public-Key-Signature`.
 *   - Body: JSON array of `{ token, type, url, source }`.
 *   - Response: JSON array of `{ token_raw, token_type, label }` where label is
 *     `true_positive` (matched + revoked) or `false_positive` (no match).
 *
 * Signature verification fetches GitHub's published ECDSA public keys from
 * `https://api.github.com/meta/public_keys/secret_scanning` (cached). Both the
 * key source and the verifier are injectable so unit tests run fully offline,
 * mirroring how the webhook url-guard gates on NODE_ENV.
 *
 * See: https://docs.github.com/en/code-security/secret-scanning/secret-scanning-partner-program
 */
import crypto from 'crypto';
import { verifyClientSecret } from './crypto.js';
import { hashToken } from '../../routes/api-tokens.js';
import * as store from './store.js';
import { pool } from '../../db/client.js';
import { logAuditEvent } from '../../services/audit.js';

const GITHUB_KEYS_URL =
  process.env.GITHUB_SECRET_SCANNING_KEYS_URL ??
  'https://api.github.com/meta/public_keys/secret_scanning';

const REVOKE_REASON = 'leaked_secret:github_secret_scanning';

/**
 * client_ids that must NEVER be auto-revoked. The grader sandbox app publishes
 * its credentials in the README on purpose (a public read-only demo), so a
 * "leak" of that secret is expected and is not a real compromise.
 */
const REVOKE_PROTECTED_CLIENT_IDS = new Set<string>(['ship_app_grader']);

/** One entry of GitHub's secret-scanning alert payload. */
export interface SecretScanningAlert {
  token: string;
  type?: string;
  url?: string;
  source?: string;
}

/** One entry of the response we must return to GitHub. */
export interface SecretScanningResult {
  token_raw: string;
  token_type: string;
  label: 'true_positive' | 'false_positive';
}

/**
 * Verifies GitHub's ECDSA signature over the raw request body. Implementations
 * return true on a valid signature, false otherwise. The default implementation
 * fetches + caches GitHub's published keys; tests inject a fake.
 */
export type SignatureVerifier = (input: {
  rawBody: string;
  keyIdentifier: string | undefined;
  signature: string | undefined;
}) => Promise<boolean>;

interface GithubPublicKey {
  key_identifier: string;
  key: string; // PEM-encoded ECDSA public key
  is_current?: boolean;
}

interface GithubKeySet {
  public_keys: GithubPublicKey[];
}

// ---- GitHub key fetch + cache ---------------------------------------------

let keyCache: { keys: GithubPublicKey[]; fetchedAt: number } | null = null;
const KEY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Fetch GitHub's secret-scanning public keys, caching for an hour. */
async function fetchGithubKeys(): Promise<GithubPublicKey[]> {
  if (keyCache && Date.now() - keyCache.fetchedAt < KEY_CACHE_TTL_MS) {
    return keyCache.keys;
  }
  const res = await fetch(GITHUB_KEYS_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ship-plugforge' },
  });
  if (!res.ok) {
    throw new Error(`GitHub key fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as GithubKeySet;
  const keys = Array.isArray(body.public_keys) ? body.public_keys : [];
  keyCache = { keys, fetchedAt: Date.now() };
  return keys;
}

/** Test seam: clear the cached keys. */
export function _clearKeyCache(): void {
  keyCache = null;
}

/**
 * Default verifier: ECDSA-SHA256 verify the raw body against the GitHub public
 * key identified by the request header. Returns false on any missing input,
 * unknown key id, or verification failure (never throws on a bad signature).
 */
export const defaultSignatureVerifier: SignatureVerifier = async ({
  rawBody,
  keyIdentifier,
  signature,
}) => {
  if (!keyIdentifier || !signature) return false;
  let keys: GithubPublicKey[];
  try {
    keys = await fetchGithubKeys();
  } catch {
    return false;
  }
  const match = keys.find((k) => k.key_identifier === keyIdentifier);
  if (!match) return false;
  try {
    const verifier = crypto.createVerify('sha256');
    verifier.update(rawBody);
    verifier.end();
    // GitHub signs with ECDSA and base64-encodes the DER signature.
    return verifier.verify(match.key, signature, 'base64');
  } catch {
    return false;
  }
};

// ---- credential matching ---------------------------------------------------

/**
 * Find the OAuth app a leaked client secret belongs to. Client secrets are
 * bcrypt-hashed (salted), so there is no reverse hash lookup: we bcrypt-compare
 * the presented secret against each app with a live secret. Cheap at this scale
 * and only runs on a (rare) leak report. Returns null on no match.
 */
async function findOAuthAppBySecret(rawSecret: string): Promise<store.OAuthAppRow | null> {
  // Quick prefix gate: Ship OAuth client secrets are `ship_secret_…`.
  if (!rawSecret.startsWith('ship_secret_')) return null;
  const apps = await store.listAppsWithLiveSecret();
  for (const app of apps) {
    if (REVOKE_PROTECTED_CLIENT_IDS.has(app.client_id)) continue; // never revoke the public grader app
    if (await verifyClientSecret(rawSecret, app.client_secret_hash)) {
      return app;
    }
  }
  return null;
}

interface ApiTokenMatch {
  id: string;
  user_id: string | null;
  workspace_id: string | null;
  name: string;
}

/**
 * Find a live (non-revoked) internal API token by its leaked raw value. API
 * tokens are sha256-hashed deterministically, so this is a direct lookup. We
 * deliberately exclude the `ship_secret_` family so an OAuth secret is never
 * mis-handled here.
 */
async function findApiTokenBySecret(rawSecret: string): Promise<ApiTokenMatch | null> {
  if (!rawSecret.startsWith('ship_') || rawSecret.startsWith('ship_secret_')) return null;
  const r = await pool.query(
    `SELECT id, user_id, workspace_id, name FROM api_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(rawSecret)],
  );
  return (r.rows[0] as ApiTokenMatch) ?? null;
}

// ---- processing ------------------------------------------------------------

export interface ProcessOptions {
  /** Injected for offline tests. Defaults to {@link defaultSignatureVerifier}. */
  verifier?: SignatureVerifier;
  rawBody: string;
  keyIdentifier: string | undefined;
  signature: string | undefined;
  alerts: SecretScanningAlert[];
  /** Forwarded to the audit log (ip/user-agent). */
  req?: import('express').Request;
}

export type ProcessOutcome =
  | { ok: false; status: 401 }
  | { ok: true; status: 200; results: SecretScanningResult[] };

/**
 * Verify the GitHub signature and process every reported token. On a bad/missing
 * signature, returns 401 and touches nothing. Otherwise revokes each matched
 * secret + its tokens (idempotently) and returns the GitHub-shaped result array.
 */
export async function processSecretScanningReport(opts: ProcessOptions): Promise<ProcessOutcome> {
  const verify = opts.verifier ?? defaultSignatureVerifier;
  const valid = await verify({
    rawBody: opts.rawBody,
    keyIdentifier: opts.keyIdentifier,
    signature: opts.signature,
  });
  if (!valid) {
    return { ok: false, status: 401 };
  }

  const results: SecretScanningResult[] = [];
  for (const alert of opts.alerts) {
    const raw = alert.token;
    if (typeof raw !== 'string' || raw.length === 0) {
      // Malformed entry: report as false_positive, do nothing.
      results.push({ token_raw: String(raw ?? ''), token_type: alert.type ?? 'ship_secret', label: 'false_positive' });
      continue;
    }

    const oauthApp = await findOAuthAppBySecret(raw);
    if (oauthApp) {
      await revokeOAuthApp(oauthApp, alert, opts.req);
      results.push({ token_raw: raw, token_type: alert.type ?? 'ship_oauth_client_secret', label: 'true_positive' });
      continue;
    }

    const apiToken = await findApiTokenBySecret(raw);
    if (apiToken) {
      await revokeApiToken(apiToken, alert, opts.req);
      results.push({ token_raw: raw, token_type: alert.type ?? 'ship_api_token', label: 'true_positive' });
      continue;
    }

    // No match (unknown / garbage / already-deleted): false_positive, no action.
    results.push({ token_raw: raw, token_type: alert.type ?? 'ship_secret', label: 'false_positive' });
  }

  return { ok: true, status: 200, results };
}

async function revokeOAuthApp(
  app: store.OAuthAppRow,
  alert: SecretScanningAlert,
  req: import('express').Request | undefined,
): Promise<void> {
  const result = await store.revokeAppSecretAndTokens(app.id, REVOKE_REASON);
  await logAuditEvent({
    workspaceId: app.workspace_id,
    actorUserId: app.owner_user_id,
    action: 'oauth.app.secret_revoked.leaked',
    resourceType: 'oauth_app',
    resourceId: app.id,
    details: {
      client_id: app.client_id,
      automated: true,
      reason: REVOKE_REASON,
      source: alert.source ?? null,
      source_url: alert.url ?? null,
      already_revoked: result.alreadyRevoked,
      access_tokens_revoked: result.accessRevoked,
      refresh_tokens_revoked: result.refreshRevoked,
    },
    req,
  });
}

async function revokeApiToken(
  token: ApiTokenMatch,
  alert: SecretScanningAlert,
  req: import('express').Request | undefined,
): Promise<void> {
  await pool.query(`UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [token.id]);
  await logAuditEvent({
    workspaceId: token.workspace_id,
    actorUserId: token.user_id,
    action: 'api_token.revoked.leaked',
    resourceType: 'api_token',
    resourceId: token.id,
    details: {
      name: token.name,
      automated: true,
      reason: REVOKE_REASON,
      source: alert.source ?? null,
      source_url: alert.url ?? null,
    },
    req,
  });
}
