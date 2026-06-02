/**
 * Webhook forwarding helper for `ship listen --forward-to <url>`.
 *
 * Verifies the Ship-Signature on an incoming delivery and, if valid, POSTs the
 * raw body (plus Ship-Signature + X-Ship-Event headers) to the target URL.
 *
 * Used by the `ship listen` command and by unit tests.
 */
import { verifyWebhook } from '@ship/sdk';
import type { ReceivedDelivery } from './webhook-listener.js';

export interface ForwardResult {
  /** true → signature verified; false → tampered / expired */
  signatureOk: boolean;
  /** HTTP status returned by the target, or null if the forward was skipped / failed */
  forwardStatus: number | null;
  /** Round-trip latency to the target in ms, or null */
  forwardLatencyMs: number | null;
  /** true → forward HTTP call itself succeeded (no network error), false → call threw */
  forwardAttempted: boolean;
}

/**
 * Verify + forward a single delivery.
 *
 * @param delivery   Raw delivery captured by the local listener.
 * @param secret     Signing secret for this subscription.
 * @param targetUrl  The developer's local server URL (--forward-to).
 * @param eventType  Event type string (e.g. "document.created"); added as X-Ship-Event.
 */
export async function verifyAndForward(
  delivery: ReceivedDelivery,
  secret: string,
  targetUrl: string,
  eventType: string,
): Promise<ForwardResult> {
  const sigOk = verifyWebhook(delivery.headers, delivery.rawBody, secret);

  if (!sigOk) {
    return { signatureOk: false, forwardStatus: null, forwardLatencyMs: null, forwardAttempted: false };
  }

  // Preserve the original signature header so the target can re-verify if desired.
  const sigHeader =
    (delivery.headers['ship-signature'] as string | undefined) ??
    (delivery.headers['Ship-Signature'] as string | undefined) ??
    '';

  const start = performance.now();
  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ship-Signature': sigHeader,
        'X-Ship-Event': eventType,
      },
      body: delivery.rawBody,
    });
    const latencyMs = Math.round(performance.now() - start);
    return { signatureOk: true, forwardStatus: res.status, forwardLatencyMs: latencyMs, forwardAttempted: true };
  } catch {
    return { signatureOk: true, forwardStatus: null, forwardLatencyMs: null, forwardAttempted: false };
  }
}
