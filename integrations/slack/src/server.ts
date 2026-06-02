/**
 * Ship → Slack webhook bridge server (deployable).
 *
 * On startup it:
 *   1. Authenticates to Ship (client_credentials via env, or Device Flow on first
 *      run with the token persisted to a file — see config.ts).
 *   2. Ensures Ship webhook subscriptions for the configured events, pointing at
 *      this server's own public URL (PUBLIC_URL + /webhooks/ship), and caches the
 *      one-time signing secrets so deliveries can be verified.
 *   3. Listens for signed Ship webhooks at POST /webhooks/ship, verifies them with
 *      @ship/sdk's verifyWebhook, and forwards a formatted message to Slack.
 *
 * Configuration (env) — see README and .env.example:
 *   PORT                  — HTTP port (default 4000)
 *   PUBLIC_URL            — public base URL Ship delivers to (e.g. https://x.ngrok.io)
 *   SHIP_BASE_URL         — Ship API origin (default http://localhost:3000)
 *   SHIP_CLIENT_ID        — OAuth client id
 *   SHIP_CLIENT_SECRET    — set → client_credentials; unset → device flow
 *   SHIP_EVENTS           — comma list (default document.created,issue.created)
 *   SHIP_WEBHOOK_SECRET   — optional override for an externally-managed subscription
 *   SLACK_WEBHOOK_URL     — Slack Incoming Webhook URL; if unset, logs instead
 */
import express from 'express';
import { handleShipWebhook, setSigningSecrets } from './handler.js';
import { ensureSubscriptions } from './subscribe.js';
import {
  PORT,
  PUBLIC_URL,
  WEBHOOK_PATH,
  SLACK_WEBHOOK_URL,
  secretFile,
  makeClient,
} from './config.js';

export function createApp(): express.Express {
  const app = express();

  // Capture the raw body BEFORE any JSON parsing so the HMAC can be verified.
  app.post(
    WEBHOOK_PATH,
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

/** Default Ship events the bridge subscribes to. */
function configuredEvents(): string[] {
  return (process.env.SHIP_EVENTS ?? 'document.created,issue.created')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Authenticate to Ship and ensure subscriptions, then register the resulting
 * signing secrets with the handler. Safe to call once at startup. If PUBLIC_URL
 * is unset we skip subscription management (the operator manages it manually and
 * supplies SHIP_WEBHOOK_SECRET) — the server still receives + verifies deliveries.
 */
export async function bootstrap(): Promise<void> {
  if (!PUBLIC_URL) {
    console.warn(
      '[slack-bridge] PUBLIC_URL not set — skipping auto-subscription. ' +
        'Set SHIP_WEBHOOK_SECRET to verify deliveries from a manually-created subscription.',
    );
    return;
  }

  const targetUrl = `${PUBLIC_URL.replace(/\/$/, '')}${WEBHOOK_PATH}`;
  const events = configuredEvents();

  console.log('[slack-bridge] Authenticating to Ship…');
  const client = await makeClient();

  console.log(`[slack-bridge] Ensuring subscriptions → ${targetUrl}  (${events.join(', ')})`);
  const result = await ensureSubscriptions({ client, targetUrl, events, secretFile });
  setSigningSecrets(Object.values(result.secrets));

  if (result.created.length) console.log(`  created: ${result.created.join(', ')}`);
  if (result.reused.length) console.log(`  reused:  ${result.reused.join(', ')}`);
}

// Only start when run as the main module (not during tests).
const isMain =
  process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');

if (isMain) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[slack-bridge] Listening on http://localhost:${PORT}${WEBHOOK_PATH}`);
    if (!SLACK_WEBHOOK_URL) {
      console.warn('  Warning: SLACK_WEBHOOK_URL not set — messages will be logged, not posted');
    }
    // Run subscription bootstrap after the listener is up so the target URL is reachable.
    bootstrap().catch((err: unknown) => {
      console.error('[slack-bridge] bootstrap failed:', err);
      console.error('  The server is still listening; fix auth/PUBLIC_URL and restart to subscribe.');
    });
  });
}
