/**
 * Shared "Liskov contract" for IWebhookDeliverer.
 *
 * This is the proof of the locked architecture decision: a queue-backed
 * deliverer must be a Liskov substitution drop-in for the in-memory one. Rather
 * than asserting that by hand twice, we factor the BEHAVIORAL assertions into
 * one contract and run it against EVERY IWebhookDeliverer implementation. Any
 * impl that passes this contract is, by construction, substitutable.
 *
 * The only thing that differs between backends is HOW time advances between
 * retries, so the contract is parameterized over a `DelivererHarness` that knows
 * how to build the deliverer+bus and how to "settle" pending work (advance a
 * TestClock for in-memory; drain the worker queue for BullMQ). Everything else —
 * the signed/idempotency-keyed POST, the 1s/4s/16s/1m/5m retry schedule, DLQ
 * after MAX_ATTEMPTS, permanent-4xx-skips-retry, replay-preserves-the-key — is
 * asserted identically for both.
 *
 * Not a *.test.ts file: it exports `runDelivererContract()`, which each backend's
 * test file calls so the suite shows up under that backend's name.
 */
import { describe, it, expect } from 'vitest';
import { createHmac, randomUUID } from 'crypto';
import { pool } from '../../../db/client.js';
import * as wstore from '../store.js';
import * as ostore from '../../oauth/store.js';
import { hashClientSecret } from '../../oauth/crypto.js';
import type { IEventBus, DomainEvent } from '../event-bus.js';
import type { Transport, TransportResult } from '../deliverer.js';

/**
 * A backend-specific test harness. The contract calls these hooks so it never
 * knows whether it is driving the in-memory queue or a Redis worker.
 */
export interface DelivererHarness {
  /**
   * Build an event bus wired to a fresh deliverer using the given transport.
   * `idle()` (below) must drive that deliverer to quiescence.
   */
  makeBus(transport: Transport): Promise<IEventBus> | IEventBus;
  /**
   * Settle pending work. `untilMs` is the cumulative virtual time the in-memory
   * clock should reach (the sum of the retry waits exercised so far); BullMQ
   * harnesses ignore it and instead wait for the worker queue to drain.
   */
  idle(stepMs: number): Promise<void>;
  /** Tear down (close workers/connections). */
  teardown?(): Promise<void>;
}

/** Each test gets an ISOLATED workspace + app + subscription (rows persist in ship_test). */
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
export function scriptedTransport(
  statuses: number[],
): Transport & { calls: { headers: Record<string, string>; body: string }[] } {
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

function eventFor(workspaceId: string): DomainEvent {
  return {
    type: 'document.created',
    workspaceId,
    data: { id: '33333333-3333-3333-3333-333333333333', document_type: 'wiki', title: 'Hi', workspace_id: workspaceId },
  };
}

/** Poll until `predicate` is true or we time out — used to await async settling. */
async function eventually(predicate: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/**
 * Run the full behavioral contract against the harness's deliverer.
 *
 * @param name      label for the describe() block (e.g. 'in-memory', 'bullmq')
 * @param harness   backend-specific build/settle hooks
 * @param fullRetrySchedule  whether the harness can time-warp the multi-minute
 *   retry schedule (TestClock can; a real-Redis BullMQ can't without waiting
 *   minutes). When false, the slow retry-then-success and DLQ-after-6 cases that
 *   need long sleeps are skipped here and covered by the deterministic
 *   backoff-mapping unit test instead; the fast paths still run.
 */
export function runDelivererContract(
  name: string,
  makeHarness: () => DelivererHarness,
  fullRetrySchedule = true,
): void {
  describe(`IWebhookDeliverer contract [${name}]`, () => {
    it('delivers a correctly-signed, idempotency-keyed POST on the first attempt', async () => {
      const { workspaceId, appId } = await setup();
      const harness = makeHarness();
      const transport = scriptedTransport([200]);
      const bus = await harness.makeBus(transport);
      try {
        await bus.publish(eventFor(workspaceId));
        await harness.idle(0);
        await eventually(async () => transport.calls.length === 1);

        const call = transport.calls[0]!;
        const sig = call.headers['Ship-Signature']!;
        const t = Number(sig.match(/t=(\d+)/)![1]);
        const v1 = sig.match(/v1=([0-9a-f]+)/)![1];
        const expected = createHmac('sha256', 'whsec_test_secret').update(`${t}.${call.body}`).digest('hex');
        expect(v1).toBe(expected);
        expect(call.headers['Idempotency-Key']).toBeTruthy();

        await eventually(async () => {
          const d = await wstore.listDeliveries(appId, workspaceId);
          return d[0]?.status === 'delivered' && d[0]?.attempt_number === 1;
        });
      } finally {
        await harness.teardown?.();
      }
    });

    it('treats a 4xx as permanent and dead-letters immediately (no retry)', async () => {
      const { workspaceId, appId } = await setup();
      const harness = makeHarness();
      const transport = scriptedTransport([404]);
      const bus = await harness.makeBus(transport);
      try {
        await bus.publish(eventFor(workspaceId));
        await harness.idle(0);
        await eventually(async () => {
          const dead = (await wstore.listDeliveries(appId, workspaceId)).find(
            (d) => d.attempt_number === 1 && d.status === 'dead',
          );
          return Boolean(dead);
        });
        expect(transport.calls).toHaveLength(1); // no retry for a permanent 4xx
      } finally {
        await harness.teardown?.();
      }
    });

    it('does NOT deliver to subscriptions owned by a DEACTIVATED app', async () => {
      const { workspaceId, appId } = await setup();
      await ostore.deactivateApp(appId); // app disabled after subscribing
      const harness = makeHarness();
      const transport = scriptedTransport([200]);
      const bus = await harness.makeBus(transport);
      try {
        await bus.publish(eventFor(workspaceId));
        await harness.idle(0);
        // Give any (erroneous) delivery a chance to fire, then assert none did.
        await new Promise((r) => setTimeout(r, 200));
        expect(transport.calls).toHaveLength(0);
      } finally {
        await harness.teardown?.();
      }
    });

    (fullRetrySchedule ? it : it.skip)(
      'retries on 500 with the 1s/4s/16s schedule and records success on the 4th attempt',
      async () => {
        const { workspaceId, appId } = await setup();
        const harness = makeHarness();
        const transport = scriptedTransport([500, 500, 500, 200]);
        const bus = await harness.makeBus(transport);
        try {
          await bus.publish(eventFor(workspaceId));
          await harness.idle(0); // attempt 1 (500)
          await eventually(async () => transport.calls.length >= 1);
          await harness.idle(1000); // wait 1s → attempt 2 (500)
          await eventually(async () => transport.calls.length >= 2);
          await harness.idle(4000); // wait 4s → attempt 3 (500)
          await eventually(async () => transport.calls.length >= 3);
          await harness.idle(16000); // wait 16s → attempt 4 (200)
          await eventually(async () => transport.calls.length >= 4);

          await eventually(async () => {
            const d = (await wstore.listDeliveries(appId, workspaceId)).find(
              (x) => x.attempt_number === 4 && x.status === 'delivered',
            );
            return Boolean(d);
          });
        } finally {
          await harness.teardown?.();
        }
      },
    );

    (fullRetrySchedule ? it : it.skip)(
      'dead-letters after MAX_ATTEMPTS failures, then replays with the original idempotency key',
      async () => {
        const { workspaceId, appId, sub } = await setup();
        const harness = makeHarness();
        const transport = scriptedTransport([500]); // always fails
        const bus = await harness.makeBus(transport);
        try {
          await bus.publish(eventFor(workspaceId));
          for (const wait of [0, 1000, 4000, 16000, 60_000, 300_000]) {
            await harness.idle(wait);
          }
          await eventually(async () => transport.calls.length === 6);

          const dead = (await wstore.listDeliveries(appId, workspaceId)).find(
            (d) => d.subscription_id === sub.id && d.status === 'dead',
          );
          expect(dead, 'should be dead-lettered after MAX_ATTEMPTS failures').toBeTruthy();

          // Replay against a now-healthy subscriber, carrying the ORIGINAL key.
          const healthyHarness = makeHarness();
          const healthy = scriptedTransport([200]);
          const replayBus = await healthyHarness.makeBus(healthy);
          try {
            // event-bus.replay() lives on InMemoryEventBus regardless of deliverer.
            const fresh = await (replayBus as unknown as {
              replay(id: string): Promise<wstore.DeliveryRow | null>;
            }).replay(dead!.id);
            await healthyHarness.idle(0);

            expect(fresh).toBeTruthy();
            expect(fresh!.idempotency_key).toBe(dead!.idempotency_key);
            await eventually(async () => healthy.calls.length === 1);
            expect(healthy.calls[0]!.headers['Idempotency-Key']).toBe(dead!.idempotency_key);
            await eventually(async () => (await wstore.getDelivery(fresh!.id))?.status === 'delivered');
          } finally {
            await healthyHarness.teardown?.();
          }
        } finally {
          await harness.teardown?.();
        }
      },
    );
  });
}
