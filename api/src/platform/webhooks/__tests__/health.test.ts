/**
 * Webhook subscription health tracking tests.
 *
 * Verifies that consecutive failures increment the counter and auto-disable
 * the subscription once the threshold is crossed, and that a successful
 * delivery resets the counter to 0.
 *
 * Uses the same deterministic TestClock + fake transport pattern as delivery.test.ts
 * so there are no real sleeps or network calls.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { pool } from '../../../db/client.js';
import * as wstore from '../store.js';
import * as ostore from '../../oauth/store.js';
import { hashClientSecret } from '../../oauth/crypto.js';
import { TestClock } from '../clock.js';
import { QueueWebhookDeliverer, AUTO_DISABLE_THRESHOLD, type Transport } from '../deliverer.js';
import { InMemoryEventBus } from '../event-bus.js';

async function setup(): Promise<{ workspaceId: string; appId: string; sub: wstore.SubscriptionRow }> {
  const tag = randomUUID().slice(0, 8);
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`Health ${tag}`]);
  const workspaceId = ws.rows[0].id;
  const u = await pool.query(`INSERT INTO users (email, name) VALUES ($1,'H') RETURNING id`, [`health-${tag}@example.com`]);
  const app = await ostore.createApp({
    clientId: `ship_app_health_${tag}`,
    clientSecretHash: await hashClientSecret('x'),
    name: 'Health App',
    redirectUris: [],
    requestedScopes: ['webhooks:manage', 'documents:write'],
    appType: 'confidential',
    ownerUserId: u.rows[0].id,
    workspaceId,
  });
  const sub = await wstore.createSubscription({
    appId: app.id,
    workspaceId,
    eventType: 'document.created',
    targetUrl: 'https://health.example.com/hook',
    signingSecret: 'whsec_health_secret',
  });
  return { workspaceId, appId: app.id, sub };
}

function scriptedTransport(statuses: number[]): Transport {
  let i = 0;
  return async () => {
    const status = statuses[Math.min(i, statuses.length - 1)]!;
    i++;
    return { status };
  };
}

function eventFor(workspaceId: string) {
  return {
    type: 'document.created' as const,
    workspaceId,
    data: {
      id: '44444444-4444-4444-4444-444444444444',
      document_type: 'wiki',
      title: 'Health Test',
      workspace_id: workspaceId,
    },
  };
}

/** Drive ALL retry attempts to exhaustion for a single published event.
 *  Waits: 0, 1s, 4s, 16s, 60s, 300s (6 attempts total) → delivery becomes dead. */
async function exhaustRetries(clock: TestClock): Promise<void> {
  for (const wait of [0, 1000, 4000, 16000, 60_000, 300_000]) {
    await clock.advance(wait);
  }
}

describe('webhook subscription health', () => {
  it('increments consecutive_failures and auto-disables after threshold', async () => {
    const { workspaceId, sub } = await setup();
    const clock = new TestClock();
    const transport = scriptedTransport([500]); // always fails
    const deliverer = new QueueWebhookDeliverer({ clock, transport, jitter: () => 0 });
    const bus = new InMemoryEventBus({ deliverer, clock });

    // Publish enough events to cross AUTO_DISABLE_THRESHOLD.
    // Each event exhausts all 6 retries → one permanent failure per event.
    for (let i = 0; i < AUTO_DISABLE_THRESHOLD; i++) {
      await bus.publish(eventFor(workspaceId));
      await exhaustRetries(clock);
    }

    const updated = await wstore.getSubscription(sub.id);
    expect(updated, 'subscription should still exist').toBeTruthy();
    expect(updated!.consecutive_failures).toBe(AUTO_DISABLE_THRESHOLD);
    expect(updated!.active).toBe(false);
    expect(updated!.disabled_reason).toMatch(/auto-disabled after \d+ consecutive/);
    expect(updated!.last_failure_at).toBeTruthy();
  });

  it('resets consecutive_failures to 0 on a successful delivery', async () => {
    const { workspaceId, sub } = await setup();
    const clock = new TestClock();
    // First two deliveries fail permanently (4xx — immediate dead-letter), third succeeds.
    const transport = scriptedTransport([404, 404, 200]);
    const deliverer = new QueueWebhookDeliverer({ clock, transport, jitter: () => 0 });
    const bus = new InMemoryEventBus({ deliverer, clock });

    // Failure 1
    await bus.publish(eventFor(workspaceId));
    await clock.advance(0);
    // Failure 2
    await bus.publish(eventFor(workspaceId));
    await clock.advance(0);

    const afterTwoFailures = await wstore.getSubscription(sub.id);
    expect(afterTwoFailures!.consecutive_failures).toBe(2);

    // Success — should reset counter to 0.
    await bus.publish(eventFor(workspaceId));
    await clock.advance(0);

    const afterSuccess = await wstore.getSubscription(sub.id);
    expect(afterSuccess!.consecutive_failures).toBe(0);
    expect(afterSuccess!.active).toBe(true);
  });

  it('does not auto-disable again if already disabled (counter keeps incrementing but active stays false)', async () => {
    const { workspaceId, sub } = await setup();
    const clock = new TestClock();
    const transport = scriptedTransport([404]); // always immediate dead-letter
    const deliverer = new QueueWebhookDeliverer({ clock, transport, jitter: () => 0 });
    const bus = new InMemoryEventBus({ deliverer, clock });

    // Cross the threshold.
    for (let i = 0; i < AUTO_DISABLE_THRESHOLD; i++) {
      await bus.publish(eventFor(workspaceId));
      await clock.advance(0);
    }

    // After threshold, subscription is inactive.  Fan-out to inactive subscriptions
    // is suppressed by getMatchingSubscriptions (active=TRUE filter), so no new
    // deliveries should be created.  The counter stays at threshold.
    const snap1 = await wstore.getSubscription(sub.id);
    expect(snap1!.active).toBe(false);
    expect(snap1!.consecutive_failures).toBe(AUTO_DISABLE_THRESHOLD);

    // Try one more publish — the inactive subscription must NOT receive it.
    const beforeCount = (await pool.query(
      `SELECT COUNT(*) FROM webhook_deliveries WHERE subscription_id = $1`, [sub.id],
    )).rows[0].count;

    await bus.publish(eventFor(workspaceId));
    await clock.advance(0);

    const afterCount = (await pool.query(
      `SELECT COUNT(*) FROM webhook_deliveries WHERE subscription_id = $1`, [sub.id],
    )).rows[0].count;

    expect(afterCount).toBe(beforeCount); // no new delivery to the disabled sub
  });
});
