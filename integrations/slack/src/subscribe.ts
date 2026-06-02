/**
 * Ensure Ship webhook subscriptions for the Slack bridge.
 *
 * The bridge wants to receive `document.created` (and `issue.created`) at its own
 * public URL. We:
 *   1. List existing subscriptions (idempotency: don't create duplicates).
 *   2. Create any missing ones via the SDK's webhooks.create().
 *   3. Persist the one-time `signing_secret` returned on create to a local file,
 *      because the API only reveals it once. The handler reads it to verify the
 *      HMAC on each delivery.
 *
 * Imports ONLY @ship/sdk + node builtins.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ShipClient } from '@ship/sdk';

/** event_type → signing_secret, keyed within a single target URL. */
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
  /** Fully-qualified URL Ship should POST deliveries to (PUBLIC_URL + path). */
  targetUrl: string;
  /** Event types to subscribe to. */
  events: string[];
  /** File to persist signing secrets to. */
  secretFile: string;
}

export interface EnsureResult {
  /** event_type → signing_secret for every subscribed event. */
  secrets: Record<string, string>;
  created: string[];
  reused: string[];
}

/**
 * Ensure a subscription exists for every requested event at `targetUrl`.
 *
 * Idempotent: if a subscription with the same (event_type, target_url) already
 * exists we keep it. We can only obtain a `signing_secret` at create time, so a
 * pre-existing subscription whose secret we don't have cached is reported in
 * `reused` with no secret — the caller should either delete+recreate it or set
 * SHIP_WEBHOOK_SECRET manually. Fresh creates always yield a secret.
 */
export async function ensureSubscriptions(opts: EnsureOptions): Promise<EnsureResult> {
  const { client, targetUrl, events, secretFile } = opts;

  const existing = await client.webhooks.list();
  const cache = loadSecretCache(secretFile) ?? { target_url: targetUrl, secrets: {} };
  // If the target changed, discard stale secrets.
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
      // Subscription exists but we lost its secret — recreate to obtain a fresh one.
      await client.webhooks.delete(already.id);
    }
    const sub = await client.webhooks.create(
      { event, target_url: targetUrl },
      { idempotencyKey: `slack-bridge:${event}:${targetUrl}:${randomUUID()}` },
    );
    secrets[event] = sub.signing_secret;
    created.push(event);
  }

  cache.secrets = secrets;
  saveSecretCache(secretFile, cache);

  return { secrets, created, reused };
}
