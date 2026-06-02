/**
 * PKCE (Proof Key for Code Exchange) helpers for browser-side OAuth 2.0.
 *
 * Spec: RFC 7636 §4.1–4.2.  Using the Web Crypto API so no Node.js required.
 * Only S256 is implemented; plain is insecure and intentionally omitted.
 */

const VERIFIER_BYTES = 32; // 256-bit → 43-char base64url string

/** Generate a cryptographically random code verifier (RFC 7636 §4.1). */
export function generateVerifier(): string {
  const buf = crypto.getRandomValues(new Uint8Array(VERIFIER_BYTES));
  return base64url(buf);
}

/**
 * Compute the S256 code_challenge for a given verifier.
 *   challenge = BASE64URL(SHA-256(ASCII(verifier)))
 */
export async function computeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return base64url(new Uint8Array(digest));
}

/** RFC 4648 §5 base64url with NO padding (= signs stripped). */
function base64url(bytes: Uint8Array): string {
  // btoa works on binary strings
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PkceParams {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** Convenience: generate verifier + challenge in one call. */
export async function generatePkce(): Promise<PkceParams> {
  const verifier = generateVerifier();
  const challenge = await computeChallenge(verifier);
  return { verifier, challenge, method: 'S256' };
}
