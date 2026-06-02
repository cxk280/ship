/**
 * Ship webhook handler for the Slack bridge.
 *
 * - Reads the raw body BEFORE any JSON parsing (required for HMAC verification).
 * - Verifies the Ship-Signature header via @ship/sdk verifyWebhook.
 * - On document.created / issue.assigned: posts a formatted message to Slack.
 *   If SLACK_WEBHOOK_URL is not set, logs the message instead (runs without a
 *   real Slack workspace in CI / local dev).
 */
import type { Request, Response } from 'express';
import { verifyWebhook } from '@ship/sdk';
import { formatEvent, type ShipEvent } from './format.js';

const EVENTS_TO_HANDLE = new Set(['document.created', 'issue.assigned']);

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
  // Read env at request time (not module load time) so tests can set it in beforeAll.
  const signingSecret = process.env.SHIP_WEBHOOK_SECRET ?? '';
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL ?? '';

  // req.body is a Buffer because we mount with express.raw().
  const rawBody: string =
    Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');

  if (!signingSecret) {
    console.warn('[slack] SHIP_WEBHOOK_SECRET not set — skipping signature verification');
  } else {
    const valid = verifyWebhook(
      req.headers as Record<string, string | string[] | undefined>,
      rawBody,
      signingSecret,
    );
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
