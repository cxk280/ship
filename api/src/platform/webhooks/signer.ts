/**
 * Webhook signers (server side).
 *
 * HMAC (existing): Ship-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
 * Ed25519 (new):   Ship-Signature-Ed25519: t=<unix-seconds>,v1=<base64-ed25519-sig>
 *
 * Both headers are produced for every delivery. HMAC uses the subscription's
 * per-subscription `signing_secret`; Ed25519 uses the app's active private key.
 * Signed payload for both: `${t}.${rawBody}` (Stripe-style).
 *
 * The timestamp defeats replay: the SDK rejects signatures older than its
 * tolerance (default 5 min).
 */
import { createHmac, sign as cryptoSign } from 'node:crypto';

export const SHIP_SIGNATURE_HEADER = 'Ship-Signature';
export const SHIP_SIGNATURE_ED25519_HEADER = 'Ship-Signature-Ed25519';

// ---- HMAC -----------------------------------------------------------------

export function computeSignature(secret: string, timestampSec: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
}

export interface SignedHeader {
  header: string; // the full Ship-Signature value
  t: number;
  v1: string;
}

export function signPayload(secret: string, rawBody: string, timestampSec: number): SignedHeader {
  const v1 = computeSignature(secret, timestampSec, rawBody);
  return { header: `t=${timestampSec},v1=${v1}`, t: timestampSec, v1 };
}

// ---- Ed25519 ---------------------------------------------------------------

export interface Ed25519SignedHeader {
  header: string; // the full Ship-Signature-Ed25519 value
  t: number;
  v1: string; // base64url signature
}

/**
 * Sign the delivery payload with an Ed25519 private key (PEM, PKCS8).
 * Returns the header value `t=<unix>,v1=<base64-sig>`.
 */
export function signPayloadEd25519(privateKeyPem: string, rawBody: string, timestampSec: number): Ed25519SignedHeader {
  const payload = Buffer.from(`${timestampSec}.${rawBody}`, 'utf8');
  const sigBuffer = cryptoSign(null, payload, privateKeyPem);
  const v1 = sigBuffer.toString('base64');
  return { header: `t=${timestampSec},v1=${v1}`, t: timestampSec, v1 };
}
