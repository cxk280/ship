/**
 * Ship webhook handler for the Slack bridge.
 *
 * - Reads the raw body BEFORE any JSON parsing (required for HMAC verification).
 * - Verifies the Ship-Signature header via @ship/sdk verifyWebhook.
 * - On document.created / issue.created / issue.assigned: posts a formatted
 *   message to Slack. If SLACK_WEBHOOK_URL is not set, logs the message instead
 *   (runs without a real Slack workspace in CI / local dev).
 *
 * Signing secrets: each Ship webhook subscription has its OWN signing secret, so
 * a bridge subscribed to multiple events may hold several. The handler verifies
 * the delivery against any configured candidate secret (set via
 * `setSigningSecrets`), falling back to the single `SHIP_WEBHOOK_SECRET` env var.
 */
import type { Request, Response } from 'express';
import { verifyWebhook } from '@ship/sdk';
import { formatEvent, type ShipEvent } from './format.js';

const EVENTS_TO_HANDLE = new Set([
  'document.created',
  'issue.created',
  'issue.assigned',
]);

/** Candidate signing secrets, populated by the server after ensuring subscriptions. */
let SIGNING_SECRETS: string[] = [];

/** Register the signing secrets to verify deliveries against (one per subscription). */
export function setSigningSecrets(secrets: string[]): void {
  SIGNING_SECRETS = secrets.filter(Boolean);
}

function candidateSecrets(): string[] {
  const envSecret = process.env.SHIP_WEBHOOK_SECRET ?? '';
  const all = [...SIGNING_SECRETS];
  if (envSecret) all.push(envSecret);
  return all;
}

/** Post a pre-formatted payload to a Slack Incoming Webhook URL. */
async function postToSlack(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Slack post failed: HTTP ${res.status} — ${text}`);
  }
}

/**
 * Express route handler.
 * Express must be configured with `express.raw({ type: '*\/*' })` upstream
 * so `req.body` is a `Buffer` (preserving the raw bytes for HMAC).
 */
export async function handleShipWebhook(req: Request, res: Response): Promise<void> {
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL ?? '';

  // req.body is a Buffer because we mount with express.raw().
  const rawBody: string =
    Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');

  const secrets = candidateSecrets();
  if (secrets.length === 0) {
    console.warn('[slack] no signing secret configured — skipping signature verification');
  } else {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const valid = secrets.some((secret) => verifyWebhook(headers, rawBody, secret));
    if (!valid) {
      res.status(400).json({ error: 'invalid_signature' });
      return;
    }
  }

  let event: ShipEvent;
  try {
    event = JSON.parse(rawBody) as ShipEvent;
  } catch {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }

  if (!EVENTS_TO_HANDLE.has(event.type)) {
    // Acknowledge but take no action for unhandled event types.
    res.status(200).json({ ok: true, handled: false });
    return;
  }

  const message = formatEvent(event);

  if (slackWebhookUrl) {
    try {
      await postToSlack(slackWebhookUrl, message);
    } catch (err) {
      console.error('[slack] Failed to post to Slack:', err);
      res.status(502).json({ error: 'slack_post_failed' });
      return;
    }
  } else {
    console.log(`[slack] SLACK_WEBHOOK_URL not set — would post:\n${JSON.stringify(message, null, 2)}`);
  }

  res.status(200).json({ ok: true, handled: true, event_type: event.type });
}
