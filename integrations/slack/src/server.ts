/**
 * Ship → Slack webhook bridge server.
 *
 * Listens for signed Ship webhooks at POST /webhooks/ship, verifies them with
 * the @ship/sdk verifyWebhook helper, and forwards formatted messages to Slack.
 *
 * Configuration (env):
 *   PORT                  — HTTP port (default 4000)
 *   SHIP_WEBHOOK_SECRET   — signing secret from the webhook subscription
 *   SLACK_WEBHOOK_URL     — Slack Incoming Webhook URL; if unset, logs instead
 */
import express from 'express';
import { handleShipWebhook } from './handler.js';

const PORT = Number(process.env.PORT ?? 4000);

export function createApp(): express.Express {
  const app = express();

  // Capture the raw body BEFORE any JSON parsing so the HMAC can be verified.
  app.post(
    '/webhooks/ship',
    express.raw({ type: '*/*', limit: '1mb' }),
    (req, res) => {
      handleShipWebhook(req, res).catch((err: unknown) => {
        console.error('[slack] unhandled error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
      });
    },
  );

  // Health check
  app.get('/health', (_req, res) => res.json({ ok: true }));

  return app;
}

// Only start listening when run as the main module (not during tests).
const isMain = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isMain) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[slack-bridge] Listening on http://localhost:${PORT}`);
    if (!process.env.SHIP_WEBHOOK_SECRET) console.warn('  Warning: SHIP_WEBHOOK_SECRET not set');
    if (!process.env.SLACK_WEBHOOK_URL) console.warn('  Warning: SLACK_WEBHOOK_URL not set — will log instead');
  });
}
