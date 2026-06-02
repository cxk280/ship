/**
 * Ensure Ship webhook subscriptions for the GitHub bridge (Ship → GitHub side).
 *
 * Same idempotent pattern as the Slack bridge: list existing subscriptions,
 * create any missing ones, and cache the one-time signing secrets to a local file
 * so deliveries can be verified with @ship/sdk's verifyWebhook.
 *
 * Imports ONLY @ship/sdk + node builtins.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ShipClient } from '@ship/sdk';

interface SecretCache {
  target_url: string;
  secrets: Record<string, string>;
}

function loadSecretCache(file: string): SecretCache | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as SecretCache;
  } catch {
    return null;
  }
}

function saveSecretCache(file: string, cache: SecretCache): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

export interface EnsureOptions {
  client: ShipClient;
  targetUrl: string;
  events: string[];
  secretFile: string;
}

export interface EnsureResult {
  secrets: Record<string, string>;
  created: string[];
  reused: string[];
}

export async function ensureSubscriptions(opts: EnsureOptions): Promise<EnsureResult> {
  const { client, targetUrl, events, secretFile } = opts;

  const existing = await client.webhooks.list();
  const cache = loadSecretCache(secretFile) ?? { target_url: targetUrl, secrets: {} };
  if (cache.target_url !== targetUrl) {
    cache.target_url = targetUrl;
    cache.secrets = {};
  }

  const created: string[] = [];
  const reused: string[] = [];
  const secrets: Record<string, string> = { ...cache.secrets };

  for (const event of events) {
    const already = existing.find(
      (s) => s.event_type === event && s.target_url === targetUrl && s.active,
    );
    if (already && secrets[event]) {
      reused.push(event);
      continue;
    }
    if (already && !secrets[event]) {
      await client.webhooks.delete(already.id);
    }
    const sub = await client.webhooks.create(
      { event, target_url: targetUrl },
      { idempotencyKey: `github-bridge:${event}:${targetUrl}:${randomUUID()}` },
    );
    secrets[event] = sub.signing_secret;
    created.push(event);
  }

  cache.secrets = secrets;
  saveSecretCache(secretFile, cache);

  return { secrets, created, reused };
}
