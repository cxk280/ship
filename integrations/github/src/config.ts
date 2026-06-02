/**
 * Config + Ship client factory for the GitHub bridge.
 *
 * Imports ONLY @ship/sdk + node builtins (the integrations boundary rule,
 * enforced by scripts/check-api-boundary.mjs) — never api/src.
 */
import os from 'node:os';
import path from 'node:path';
import { ShipClient, FileTokenStore } from '@ship/sdk';

// ---- Ship ------------------------------------------------------------------

export const SHIP_BASE_URL = process.env.SHIP_BASE_URL ?? 'http://localhost:3000';
export const SHIP_CLIENT_ID = process.env.SHIP_CLIENT_ID ?? 'ship_app_cli';
export const SHIP_CLIENT_SECRET = process.env.SHIP_CLIENT_SECRET;
export const SHIP_SCOPES =
  process.env.SHIP_SCOPES ?? 'issues:read issues:write documents:write webhooks:manage';

/** Public base URL this server is reachable at (used to build webhook targets). */
export const PUBLIC_URL = process.env.PUBLIC_URL ?? '';

/** Ship → GitHub: which Ship events to mirror to GitHub issues. */
export const SHIP_EVENTS = (process.env.SHIP_EVENTS ?? 'issue.created,issue.status_changed')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const SHIP_WEBHOOK_PATH = '/webhooks/ship';
export const GITHUB_WEBHOOK_PATH = '/webhooks/github';

export const PORT = Number(process.env.PORT ?? 4100);

// ---- GitHub ----------------------------------------------------------------

/** Fine-grained or classic PAT with `repo` (issues) scope. */
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
/** "owner/repo". */
export const GITHUB_REPO = process.env.GITHUB_REPO ?? '';
/** Shared secret configured on the GitHub webhook (X-Hub-Signature-256). */
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
export const GITHUB_API_BASE = process.env.GITHUB_API_BASE ?? 'https://api.github.com';

// ---- Token persistence -----------------------------------------------------

export const tokenFile =
  process.env.SHIP_TOKEN_FILE ?? path.join(os.homedir(), '.ship', 'github-bridge.json');
export const secretFile =
  process.env.SHIP_WEBHOOK_SECRET_FILE ??
  path.join(os.homedir(), '.ship', 'github-bridge-secret.json');

export const tokenStore = new FileTokenStore(tokenFile);

export function hasClientCredentials(): boolean {
  return Boolean(SHIP_CLIENT_ID && SHIP_CLIENT_SECRET);
}

/** Build a ready-to-use ShipClient (client_credentials or persisted device flow). */
export async function makeShipClient(): Promise<ShipClient> {
  if (hasClientCredentials()) {
    return new ShipClient({
      baseUrl: SHIP_BASE_URL,
      clientId: SHIP_CLIENT_ID,
      clientSecret: SHIP_CLIENT_SECRET,
    });
  }

  const cached = await tokenStore.get();
  if (cached?.access_token) {
    return new ShipClient({ baseUrl: SHIP_BASE_URL, tokenStore, clientId: SHIP_CLIENT_ID });
  }

  return ShipClient.deviceLogin({
    origin: SHIP_BASE_URL,
    clientId: SHIP_CLIENT_ID,
    scope: SHIP_SCOPES,
    tokenStore,
    onUserCode: (code, verifyUrl) => {
      console.log(`\n  To authorize the GitHub bridge, open:  ${verifyUrl}`);
      console.log(`  and enter the code:  ${code}\n  Waiting for approval…\n`);
    },
  });
}
