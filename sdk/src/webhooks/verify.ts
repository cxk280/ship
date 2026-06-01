/**
 * Webhook signature verification — one call, true/false.
 *
 * Header: `Ship-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>`
 * Signed payload: `${t}.${rawBody}` (Stripe-style). The timestamp defeats replay;
 * we reject signatures older than `toleranceSec` (default 300s). Constant-time
 * comparison. Tampered body, expired timestamp, or missing v1 all return false.
 *
 * Pass the RAW request body (string), never the parsed/re-serialized object.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SHIP_SIGNATURE_HEADER = 'Ship-Signature';

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
    const [k, val] = part.split('=', 2);
    if (k?.trim() === 't' && val) t = Number(val.trim());
    if (k?.trim() === 'v1' && val) v1 = val.trim();
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
