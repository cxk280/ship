/**
 * Config + Ship client factory for the Slack bridge.
 *
 * Imports ONLY @ship/sdk (the integrations boundary rule, enforced by
 * scripts/check-api-boundary.mjs) — never api/src.
 *
 * Two auth modes, selected by env:
 *   - client_credentials: set SHIP_CLIENT_ID + SHIP_CLIENT_SECRET (machine app).
 *   - device flow:        set SHIP_CLIENT_ID (+ optional secret) and approve in a
 *                         browser on first run; the token is persisted to a file
 *                         (SHIP_TOKEN_FILE, default ~/.ship/slack-bridge.json) so
 *                         restarts don't re-prompt.
 */
import os from 'node:os';
import path from 'node:path';
import { ShipClient, FileTokenStore } from '@ship/sdk';

export const BASE_URL = process.env.SHIP_BASE_URL ?? 'http://localhost:3000';
export const CLIENT_ID = process.env.SHIP_CLIENT_ID ?? 'ship_app_cli';
export const CLIENT_SECRET = process.env.SHIP_CLIENT_SECRET; // present → client_credentials
export const SCOPES = process.env.SHIP_SCOPES ?? 'documents:read webhooks:manage';

/** Public base URL this server is reachable at (used to build the webhook target). */
export const PUBLIC_URL = process.env.PUBLIC_URL ?? '';

/** Path under which this server receives Ship webhooks. */
export const WEBHOOK_PATH = '/webhooks/ship';

export const PORT = Number(process.env.PORT ?? 4000);

export const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? '';

/** Where the device-flow token is persisted between restarts. */
export const tokenFile =
  process.env.SHIP_TOKEN_FILE ?? path.join(os.homedir(), '.ship', 'slack-bridge.json');

/** Where the resolved webhook signing secret is cached (so we verify deliveries). */
export const secretFile =
  process.env.SHIP_WEBHOOK_SECRET_FILE ??
  path.join(os.homedir(), '.ship', 'slack-bridge-secret.json');

export const tokenStore = new FileTokenStore(tokenFile);

/** True when client_credentials env is fully configured. */
export function hasClientCredentials(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

/**
 * Build a ready-to-use ShipClient.
 *
 * - client_credentials mode: returns a client immediately; the SDK obtains a
 *   token on first request via the configured clientId/secret.
 * - device mode: runs the Device Authorization Grant (printing the user code),
 *   persisting the token to `tokenStore`. On subsequent runs the cached token is
 *   reused (no prompt) unless it has been cleared.
 */
export async function makeClient(): Promise<ShipClient> {
  if (hasClientCredentials()) {
    return new ShipClient({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
  }

  // Device flow: reuse a cached token if present.
  const cached = await tokenStore.get();
  if (cached?.access_token) {
    return new ShipClient({ baseUrl: BASE_URL, tokenStore, clientId: CLIENT_ID });
  }

  return ShipClient.deviceLogin({
    origin: BASE_URL,
    clientId: CLIENT_ID,
    scope: SCOPES,
    tokenStore,
    onUserCode: (code, verifyUrl) => {
      console.log(`\n  To authorize the Slack bridge, open:  ${verifyUrl}`);
      console.log(`  and enter the code:  ${code}\n  Waiting for approval…\n`);
    },
  });
}
