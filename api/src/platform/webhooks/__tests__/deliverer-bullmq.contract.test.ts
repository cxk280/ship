/**
 * Runs the SAME shared IWebhookDeliverer contract against the Redis-backed
 * BullMqWebhookDeliverer — the Liskov proof. If both the in-memory and the
 * BullMQ deliverer satisfy the identical contract, the BullMQ impl is a
 * substitution drop-in (which is the locked architecture decision for this
 * project: swap the queue backend, change no callers).
 *
 * This is GUARDED on a real Redis, because BullMQ needs a live Redis to exercise
 * its delayed-job / worker path faithfully (ioredis-mock does not implement the
 * Lua-script + blocking-pop semantics BullMQ depends on for delayed retries).
 * - With REDIS_URL set, we run the FAST behaviors (happy-path delivery,
 *   immediate-DLQ-on-4xx, no-fanout-to-dead-app). We do NOT time-warp the
 *   multi-minute retry schedule here (that would mean waiting 5+ minutes of real
 *   time); the schedule math is locked down deterministically by
 *   backoff.test.ts instead, against the SAME backoffForAttempt() the deliverer
 *   uses.
 * - Without REDIS_URL we SKIP with a CLEAR message — we do NOT silently pass.
 *
 * To run the Redis integration leg locally:
 *   REDIS_URL=redis://localhost:6379 pnpm --filter @ship/api test deliverer-bullmq
 */
import { describe, it } from 'vitest';
import { systemClock } from '../clock.js';
import { BullMqWebhookDeliverer } from '../bullmq-deliverer.js';
import { InMemoryEventBus } from '../event-bus.js';
import { runDelivererContract, type DelivererHarness } from './deliverer-contract.js';

const REDIS_URL = process.env.REDIS_URL;

if (REDIS_URL) {
  function bullMqHarness(): DelivererHarness {
    // Unique queue name per harness so concurrent/leftover jobs never cross tests.
    const queueName = `webhook-deliveries-test-${Math.random().toString(36).slice(2)}`;
    let deliverer: BullMqWebhookDeliverer | undefined;
    return {
      makeBus(transport) {
        deliverer = new BullMqWebhookDeliverer({
          connection: REDIS_URL!,
          transport,
          clock: systemClock,
          jitter: () => 0,
          queueName,
          concurrency: 1,
        });
        return new InMemoryEventBus({ deliverer, clock: systemClock });
      },
      // BullMQ's worker drains on its own; `eventually(...)` in the contract polls
      // for the observable result, so idle() is a no-op here.
      async idle() {
        /* worker drives itself */
      },
      async teardown() {
        await deliverer?.close();
      },
    };
  }

  // fullRetrySchedule=false: skip the multi-minute slow-retry cases (covered by
  // backoff.test.ts); run the fast paths against real Redis.
  runDelivererContract('bullmq (redis)', bullMqHarness, /* fullRetrySchedule */ false);
} else {
  describe('IWebhookDeliverer contract [bullmq (redis)]', () => {
    it.skip('SKIPPED: set REDIS_URL to run the BullMQ Liskov contract against a live Redis (e.g. REDIS_URL=redis://localhost:6379). Backoff/DLQ math is still covered deterministically by backoff.test.ts.', () => {
      /* intentionally skipped — not a silent pass */
    });
  });
}
