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

export const credentialsPath = path.join(os.homedir(), '.ship', 'credentials.json');
export const tokenStore = new FileTokenStore(credentialsPath);

export function client(): ShipClient {
  return new ShipClient({ baseUrl: BASE_URL, tokenStore, clientId: CLIENT_ID });
}
