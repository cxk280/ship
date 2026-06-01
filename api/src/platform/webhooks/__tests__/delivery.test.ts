/**
 * Webhook delivery integration tests — retry schedule, DLQ, replay — driven by a
 * deterministic TestClock + a fake transport (no real network, no sleeps).
 * Covers PRD testing scenarios 5 (signed delivery), 6 (retry then success),
 * 7 (DLQ + replay with original idempotency key).
 */
import { describe, it, expect } from 'vitest';
import { createHmac, randomUUID } from 'crypto';
import { pool } from '../../../db/client.js';
import * as wstore from '../store.js';
import * as ostore from '../../oauth/store.js';
import { hashClientSecret } from '../../oauth/crypto.js';
import { TestClock } from '../clock.js';
import { QueueWebhookDeliverer, type Transport, type TransportResult } from '../deliverer.js';
import { InMemoryEventBus } from '../event-bus.js';

/** Each test gets an ISOLATED workspace + app + subscription so fan-out matches
 *  exactly one subscriber (subscriptions persist across tests in ship_test). */
async function setup(): Promise<{ workspaceId: string; appId: string; sub: wstore.SubscriptionRow }> {
  const tag = randomUUID().slice(0, 8);
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`WH ${tag}`]);
  const workspaceId = ws.rows[0].id;
  const u = await pool.query(`INSERT INTO users (email, name) VALUES ($1,'WH') RETURNING id`, [`wh-${tag}@example.com`]);
  const app = await ostore.createApp({
    clientId: `ship_app_wh_${tag}`, clientSecretHash: await hashClientSecret('x'), name: 'WH App',
    redirectUris: [], requestedScopes: ['webhooks:manage', 'documents:write'], appType: 'confidential',
    ownerUserId: u.rows[0].id, workspaceId,
  });
  const sub = await wstore.createSubscription({
    appId: app.id, workspaceId, eventType: 'document.created', targetUrl: 'https://sub.example.com/hook',
    signingSecret: 'whsec_test_secret',
  });
  return { workspaceId, appId: app.id, sub };
}

/** Fake transport returning a programmed status sequence; records every call. */
function scriptedTransport(statuses: number[]): Transport & { calls: { headers: Record<string, string>; body: string }[] } {
  const calls: { headers: Record<string, string>; body: string }[] = [];
  let i = 0;
  const fn = (async (_url, opts) => {
    calls.push({ headers: opts.headers, body: opts.body });
    const status = statuses[Math.min(i, statuses.length - 1)]!;
    i++;
    return { status } as TransportResult;
  }) as Transport & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

function eventFor(workspaceId: string) {
  return {
    type: 'document.created' as const,
    workspaceId,
    data: { id: '33333333-3333-3333-3333-333333333333', document_type: 'wiki', title: 'Hi', workspace_id: workspaceId },
  };
}

describe('signed delivery (happy path)', () => {
  it('delivers a correctly-signed, idempotency-keyed POST on the first attempt', async () => {
    const { workspaceId, appId } = await setup();
    const clock = new TestClock();
    const transport = scriptedTransport([200]);
    const bus = new InMemoryEventBus({ deliverer: new QueueWebhookDeliverer({ clock, transport, jitter: () => 0 }), clock });

    await bus.publish(eventFor(workspaceId));
    await clock.advance(0); // run attempt 1

    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    // The signature verifies against the subscription secret.
    const sig = call.headers['Ship-Signature']!;
    const t = Number(sig.match(/t=(\d+)/)![1]);
    const v1 = sig.match(/v1=([0-9a-f]+)/)![1];
    const expected = createHmac('sha256', 'whsec_test_secret').update(`${t}.${call.body}`).digest('hex');
    expect(v1).toBe(expected);
    expect(call.headers['Idempotency-Key']).toBeTruthy();

    const deliveries = await wstore.listDeliveries(appId, workspaceId);
    expect(deliveries[0]!.status).toBe('delivered');
    expect(deliveries[0]!.attempt_number).toBe(1);
  });
});

describe('retry then success (scenario 6)', () => {
  it('retries on 500 with the 1s/4s/16s schedule and records success on the 4th attempt', async () => {
    const { workspaceId, appId } = await setup();
    const clock = new TestClock();
    const transport = scriptedTransport([500, 500, 500, 200]);
    const bus = new InMemoryEventBus({ deliverer: new QueueWebhookDeliverer({ clock, transport, jitter: () => 0 }), clock });

    await bus.publish(eventFor(workspaceId));
    await clock.advance(0); // attempt 1 (500)
    expect(transport.calls).toHaveLength(1);
    await clock.advance(1000); // wait 1s → attempt 2 (500)
    expect(transport.calls).toHaveLength(2);
    await clock.advance(4000); // wait 4s → attempt 3 (500)
    expect(transport.calls).toHaveLength(3);
    await clock.advance(16000); // wait 16s → attempt 4 (200)
    expect(transport.calls).toHaveLength(4);

    const d = (await wstore.listDeliveries(appId, workspaceId)).find((x) => x.attempt_number === 4 && x.status === 'delivered');
    expect(d, 'fourth attempt should record success').toBeTruthy();
  });
});

describe('DLQ + replay (scenario 7)', () => {
  it('dead-letters after 6 failures, then replays with the original idempotency key', async () => {
    const { workspaceId, appId, sub } = await setup();
    const clock = new TestClock();
    const transport = scriptedTransport([500]); // always fails
    const deliverer = new QueueWebhookDeliverer({ clock, transport, jitter: () => 0 });
    const bus = new InMemoryEventBus({ deliverer, clock });

    await bus.publish(eventFor(workspaceId));
    // Drive all 6 attempts (waits 1s,4s,16s,1m,5m between them).
    for (const wait of [0, 1000, 4000, 16000, 60_000, 300_000]) await clock.advance(wait);
    expect(transport.calls).toHaveLength(6);

    const dead = (await wstore.listDeliveries(appId, workspaceId)).find((d) => d.subscription_id === sub.id && d.status === 'dead');
    expect(dead, 'should be dead-lettered after 6 failures').toBeTruthy();

    // Replay against a now-healthy subscriber, carrying the ORIGINAL idempotency key.
    const healthy = scriptedTransport([200]);
    const replayClock = new TestClock();
    const replayBus = new InMemoryEventBus({
      deliverer: new QueueWebhookDeliverer({ clock: replayClock, transport: healthy, jitter: () => 0 }),
      clock: replayClock,
    });
    const fresh = await replayBus.replay(dead!.id);
    await replayClock.advance(0);

    expect(fresh).toBeTruthy();
    expect(fresh!.idempotency_key).toBe(dead!.idempotency_key);
    expect(healthy.calls[0]!.headers['Idempotency-Key']).toBe(dead!.idempotency_key);
    const replayed = await wstore.getDelivery(fresh!.id);
    expect(replayed!.status).toBe('delivered');
  });

  it('does NOT deliver to subscriptions owned by a DEACTIVATED app', async () => {
    const { workspaceId, appId } = await setup();
    await ostore.deactivateApp(appId); // app disabled after subscribing
    const clock = new TestClock();
    const transport = scriptedTransport([200]);
    const bus = new InMemoryEventBus({ deliverer: new QueueWebhookDeliverer({ clock, transport, jitter: () => 0 }), clock });
    await bus.publish(eventFor(workspaceId));
    await clock.advance(0);
    expect(transport.calls).toHaveLength(0); // no fan-out to a dead app
  });

  it('treats a 4xx as permanent and dead-letters immediately', async () => {
    const { workspaceId, appId } = await setup();
    const clock = new TestClock();
    const transport = scriptedTransport([404]);
    const bus = new InMemoryEventBus({ deliverer: new QueueWebhookDeliverer({ clock, transport, jitter: () => 0 }), clock });
    await bus.publish(eventFor(workspaceId));
    await clock.advance(0);
    expect(transport.calls).toHaveLength(1); // no retry
    const dead = (await wstore.listDeliveries(appId, workspaceId)).find((d) => d.attempt_number === 1 && d.status === 'dead');
    expect(dead).toBeTruthy();
  });
});
