/**
 * Webhook signature verification — one call, true/false.
 *
 * HMAC header: `Ship-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>`
 * Ed25519 header: `Ship-Signature-Ed25519: t=<unix-seconds>,v1=<base64-ed25519-sig>`
 * Signed payload: `${t}.${rawBody}` (Stripe-style). The timestamp defeats replay;
 * we reject signatures older than `toleranceSec` (default 300s). Constant-time
 * comparison for HMAC. Tampered body, expired timestamp, or missing v1 all return false.
 *
 * Pass the RAW request body (string), never the parsed/re-serialized object.
 */
import { createHmac, timingSafeEqual, verify as cryptoVerify, createPublicKey } from 'node:crypto';

export const SHIP_SIGNATURE_HEADER = 'Ship-Signature';
export const SHIP_SIGNATURE_ED25519_HEADER = 'Ship-Signature-Ed25519';

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** Compute the `v1` HMAC hex for a timestamp + raw body. Shared by signer + verifier. */
export function computeSignature(secret: string, timestamp: number | string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  let t: number | undefined;
  let v1: string | undefined;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (k === 't' && val) t = Number(val);
    if (k === 'v1' && val) v1 = val;
  }
  if (t === undefined || Number.isNaN(t) || !v1) return null;
  return { t, v1 };
}

export function verifyWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  secret: string,
  toleranceSec = 300,
): boolean {
  const raw = headerValue(headers, SHIP_SIGNATURE_HEADER);
  if (!raw) return false;
  const parsed = parseSignatureHeader(raw);
  if (!parsed) return false;

  // Replay defense: reject stale (or absurdly future) timestamps.
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.t) > toleranceSec) return false;

  const expected = computeSignature(secret, parsed.t, rawBody);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(parsed.v1, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify the `Ship-Signature-Ed25519` header using an Ed25519 public key (PEM, SPKI).
 *
 * The header format is `t=<unix-seconds>,v1=<base64-ed25519-sig>`.
 * Signed payload: `${t}.${rawBody}` — same structure as the HMAC verifier.
 * Returns false on tampered body, expired timestamp, missing header, or wrong key.
 *
 * Zero new dependencies: uses node:crypto built-ins only.
 */
export function verifyWebhookEd25519(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  publicKeyPem: string,
  toleranceSec = 300,
): boolean {
  const raw = headerValue(headers, SHIP_SIGNATURE_ED25519_HEADER);
  if (!raw) return false;
  const parsed = parseSignatureHeader(raw);
  if (!parsed) return false;

  // Replay defense: reject stale (or absurdly future) timestamps.
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.t) > toleranceSec) return false;

  try {
    const pubKey = createPublicKey(publicKeyPem);
    const payload = Buffer.from(`${parsed.t}.${rawBody}`, 'utf8');
    const sigBuffer = Buffer.from(parsed.v1, 'base64');
    return cryptoVerify(null, payload, pubKey, sigBuffer);
  } catch {
    return false;
  }
}
