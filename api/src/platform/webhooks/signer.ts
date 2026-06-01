/**
 * Webhook HMAC signer (server side). Produces the Stripe-style header
 *   Ship-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
 * over the signed payload `${t}.${rawBody}`. This convention is identical to the
 * SDK's verifyWebhook/computeSignature — a cross-check test asserts they agree,
 * so a subscriber using @ship/sdk verifies exactly what we sign.
 *
 * The timestamp in the header is what defeats replay: the SDK rejects signatures
 * older than its tolerance (default 5 min).
 */
import { createHmac } from 'crypto';

export const SHIP_SIGNATURE_HEADER = 'Ship-Signature';

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
