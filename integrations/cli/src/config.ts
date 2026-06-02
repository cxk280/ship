/**
 * CLI config + client factory. Imports ONLY @ship/sdk (the integrations boundary
 * rule, enforced by scripts/check-api-boundary.mjs) — never api/src.
 */
import os from 'node:os';
import path from 'node:path';
import { ShipClient, FileTokenStore } from '@ship/sdk';

export const BASE_URL = process.env.SHIP_BASE_URL ?? 'http://localhost:3000';
export const CLIENT_ID = process.env.SHIP_CLIENT_ID ?? 'ship_app_cli';
export const SCOPES = process.env.SHIP_SCOPES ?? 'documents:read documents:write webhooks:manage';

/**
 * Public callback URL for webhook receivers (`ship webhooks tail` / `ship listen`).
 * Set this to a tunnel URL (e.g. an ngrok https URL) when pointing the CLI at a REMOTE
 * or deployed Ship, so the platform can deliver to your local listener. Pair it with
 * SHIP_LISTEN_PORT so the tunnel has a stable port to forward to. Unset = local-only.
 */
export const PUBLIC_URL = process.env.SHIP_PUBLIC_URL || undefined;
export const LISTEN_PORT = process.env.SHIP_LISTEN_PORT ? Number(process.env.SHIP_LISTEN_PORT) : undefined;

export const credentialsPath = path.join(os.homedir(), '.ship', 'credentials.json');
export const tokenStore = new FileTokenStore(credentialsPath);

export function client(): ShipClient {
  return new ShipClient({ baseUrl: BASE_URL, tokenStore, clientId: CLIENT_ID });
}
