/**
 * Verify GitHub webhook deliveries (X-Hub-Signature-256).
 *
 * GitHub signs the RAW request body with HMAC-SHA256 using the webhook secret and
 * sends `X-Hub-Signature-256: sha256=<hex>`. Constant-time comparison.
 *
 * (Ship deliveries are verified with @ship/sdk's verifyWebhook; this is the
 * GitHub-side equivalent — GitHub is a third-party we don't control, so we
 * implement its scheme here with node:crypto built-ins.)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const GITHUB_SIGNATURE_HEADER = 'X-Hub-Signature-256';

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/**
 * Returns true iff the `X-Hub-Signature-256` header matches an HMAC-SHA256 of the
 * raw body under `secret`. Missing header / malformed value / mismatch → false.
 */
export function verifyGitHubSignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  secret: string,
): boolean {
  const header = headerValue(headers, GITHUB_SIGNATURE_HEADER);
  if (!header || !header.startsWith('sha256=')) return false;
  const provided = header.slice('sha256='.length);
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
