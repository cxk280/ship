/**
 * PKCE (RFC 7636) helpers for the Authorization Code flow. S256 only — the
 * `plain` method is intentionally not offered.
 */
import { createHash, randomBytes } from 'crypto';

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Pkce {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/** Generate a high-entropy verifier and its S256 challenge. */
export function generatePkce(): Pkce {
  const codeVerifier = base64url(randomBytes(32)); // 43-char URL-safe verifier
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

/** An unguessable `state` value for CSRF protection on the redirect. */
export function randomState(): string {
  return base64url(randomBytes(16));
}
