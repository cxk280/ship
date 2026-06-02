/**
 * Deterministic, Redis-FREE coverage of the retry/DLQ logic that the BullMQ
 * deliverer maps onto Redis delayed jobs. Two layers:
 *
 *  1. backoffForAttempt(n) — the NON-exponential 1s/4s/16s/1m/5m schedule the
 *     BullMQ deliverer reads to set each job's `delay`. We assert the exact table
 *     and the boundaries (no retry after the last attempt). This is the schedule
 *     the BullMQ contract test deliberately does NOT time-warp, so it is pinned
 *     down here instead.
 *
 *  2. processAttempt(...) — the shared per-attempt state machine BOTH deliverers
 *     call. We assert the AttemptOutcome it returns (delivered / dead / retry)
 *     for the key status classes, proving the BullMQ worker and the in-memory
 *     loop branch identically. Runs against the real DB delivery row (no network,
 *     no Redis) using a fake transport + TestClock.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { pool } from '../../../db/client.js';
import * as wstore from '../store.js';
import * as ostore from '../../oauth/store.js';
import { hashClientSecret } from '../../oauth/crypto.js';
import { TestClock } from '../clock.js';
import {
  backoffForAttempt,
  isTransient,
  processAttempt,
  RETRY_DELAYS_MS,
  MAX_ATTEMPTS,
  type DeliveryJob,
  type Transport,
} from '../deliverer.js';

describe('backoffForAttempt — non-exponential schedule mapping', () => {
  it('matches the 1s/4s/16s/1m/5m table for attempts 1..5', () => {
    expect(backoffForAttempt(1)).toBe(1000);
    expect(backoffForAttempt(2)).toBe(4000);
    expect(backoffForAttempt(3)).toBe(16000);
    expect(backoffForAttempt(4)).toBe(60_000);
    expect(backoffForAttempt(5)).toBe(300_000);
  });

  it('reads exactly from RETRY_DELAYS_MS (no duplicated constants)', () => {
    for (let n = 1; n < MAX_ATTEMPTS; n++) {
      expect(backoffForAttempt(n)).toBe(RETRY_DELAYS_MS[n - 1]);
    }
  });

  it('returns 0 after the final attempt and for out-of-range input', () => {
    expect(backoffForAttempt(MAX_ATTEMPTS)).toBe(0); // 6th attempt → no further retry
    expect(backoffForAttempt(0)).toBe(0);
    expect(backoffForAttempt(-1)).toBe(0);
    expect(backoffForAttempt(999)).toBe(0);
  });
});

describe('isTransient — retry vs permanent classification', () => {
  it('treats network errors, 5xx, 408, 429 as transient', () => {
    expect(isTransient(0)).toBe(true);
    expect(isTransient(500)).toBe(true);
    expect(isTransient(503)).toBe(true);
    expect(isTransient(408)).toBe(true);
    expect(isTransient(429)).toBe(true);
  });
  it('treats other 4xx as permanent', () => {
    expect(isTransient(400)).toBe(false);
    expect(isTransient(401)).toBe(false);
    expect(isTransient(404)).toBe(false);
  });
});

async function makeJob(): Promise<DeliveryJob> {
  const tag = randomUUID().slice(0, 8);
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`BO ${tag}`]);
  const workspaceId = ws.rows[0].id;
  const u = await pool.query(`INSERT INTO users (email, name) VALUES ($1,'BO') RETURNING id`, [`bo-${tag}@example.com`]);
  const app = await ostore.createApp({
    clientId: `ship_app_bo_${tag}`, clientSecretHash: await hashClientSecret('x'), name: 'BO App',
    redirectUris: [], requestedScopes: ['webhooks:manage'], appType: 'confidential',
    ownerUserId: u.rows[0].id, workspaceId,
  });
  const sub = await wstore.createSubscription({
    appId: app.id, workspaceId, eventType: 'document.created',
    targetUrl: 'https://sub.example.com/hook', signingSecret: 'whsec_bo',
  });
  const event = await wstore.insertEvent({
    eventType: 'document.created', workspaceId, payload: { test: true }, idempotencyKey: `k_${tag}`,
  });
  const delivery = await wstore.insertDelivery({
    subscriptionId: sub.id, eventId: event.id, eventType: 'document.created', idempotencyKey: `k_${tag}`,
  });
  return {
    deliveryId: delivery.id,
    subscription: { id: sub.id, targetUrl: sub.target_url, signingSecret: sub.signing_secret },
    envelope: { id: event.id, type: 'document.created', created: 0, data: { test: true } },
    idempotencyKey: `k_${tag}`,
  };
}

const fixedTransport = (status: number): Transport => async () => ({ status });

describe('processAttempt — shared per-attempt outcome', () => {
  it('returns {kind:delivered} and marks the row delivered on 2xx', async () => {
    const job = await makeJob();
    const clock = new TestClock();
    const outcome = await processAttempt(job, 1, { clock, transport: fixedTransport(200), jitter: () => 0 });
    expect(outcome).toEqual({ kind: 'delivered' });
    expect((await wstore.getDelivery(job.deliveryId))!.status).toBe('delivered');
  });

  it('returns {kind:retry} with the scheduled backoff on a transient 5xx (retries remain)', async () => {
    const job = await makeJob();
    const clock = new TestClock();
    const outcome = await processAttempt(job, 2, { clock, transport: fixedTransport(503), jitter: () => 0 });
    expect(outcome).toEqual({ kind: 'retry', delayMs: backoffForAttempt(2) });
    expect((await wstore.getDelivery(job.deliveryId))!.status).toBe('pending');
  });

  it('returns {kind:dead} immediately on a permanent 4xx (no retry)', async () => {
    const job = await makeJob();
    const clock = new TestClock();
    const outcome = await processAttempt(job, 1, { clock, transport: fixedTransport(404), jitter: () => 0 });
    expect(outcome).toEqual({ kind: 'dead' });
    expect((await wstore.getDelivery(job.deliveryId))!.status).toBe('dead');
  });

  it('returns {kind:dead} when retries are exhausted at MAX_ATTEMPTS even for a transient status', async () => {
    const job = await makeJob();
    const clock = new TestClock();
    const outcome = await processAttempt(job, MAX_ATTEMPTS, { clock, transport: fixedTransport(500), jitter: () => 0 });
    expect(outcome).toEqual({ kind: 'dead' });
    expect((await wstore.getDelivery(job.deliveryId))!.status).toBe('dead');
  });
});
