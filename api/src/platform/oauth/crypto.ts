/**
 * OAuth credential generation + hashing.
 *
 * Secrets at rest:
 *  - client_secret  → bcrypt (slow, salted; survives a DB leak)            [PRD 1.4]
 *  - access/refresh/device/authorization codes → SHA-256 hex (fast lookup by hash)
 *
 * Raw values are returned to the caller exactly once and never persisted.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

/** SHA-256 hex of a token — what we store and look up by. */
export function sha256(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${crypto.randomBytes(bytes).toString('hex')}`;
}

export const generate = {
  clientId: () => randomToken('ship_app_', 12),
  clientSecret: () => randomToken('ship_secret_', 32),
  accessToken: () => randomToken('ship_at_', 32),
  refreshToken: () => randomToken('ship_rt_', 32),
  deviceCode: () => randomToken('ship_dc_', 32),
  authorizationCode: () => randomToken('ship_ac_', 24),
};

/**
 * RFC 8628 user_code: short, human-keyable, no ambiguous characters
 * (no 0/O/1/I). Format: XXXX-XXXX.
 */
export function generateUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${pick()}-${pick()}`;
}

export async function hashClientSecret(secret: string): Promise<string> {
  return bcrypt.hash(secret, BCRYPT_ROUNDS);
}

export async function verifyClientSecret(secret: string, hash: string): Promise<boolean> {
  return bcrypt.compare(secret, hash);
}

/**
 * RFC 7636 PKCE verification. S256 (recommended) compares
 * base64url(SHA-256(verifier)) to the stored challenge; plain compares directly.
 * Uses a constant-time comparison.
 */
export function verifyPkce(
  verifier: string,
  challenge: string,
  method: 'S256' | 'plain',
): boolean {
  let computed: string;
  if (method === 'S256') {
    computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  } else {
    computed = verifier;
  }
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
