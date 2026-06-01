/**
 * Webhook deliverer — the retry/DLQ state machine.
 *
 * IWebhookDeliverer is the seam (DIP): this in-memory queue deliverer is the
 * must-ship impl; a BullMQ/SQS deliverer is a Liskov drop-in (same interface,
 * same signed payload). HTTP transport and the Clock are injected so tests run
 * deterministically with a fake transport + TestClock — never real sleeps.
 *
 * Retry: wait 1s, 4s, 16s, 1m, 5m before attempts 2..6 (+optional jitter). 5xx /
 * timeout / 408 / 429 are transient (retry); other 4xx are permanent (→ DLQ).
 * After 6 failed attempts the delivery is dead-lettered (status='dead').
 */
import { signPayload } from './signer.js';
import type { Clock } from './clock.js';
import type { WebhookEnvelope } from './events.js';
import { updateDeliveryAttempt } from './store.js';

export const RETRY_DELAYS_MS = [1000, 4000, 16000, 60_000, 300_000, 1_800_000];
export const MAX_ATTEMPTS = 6;

export interface TransportResult {
  status: number;
  bodyExcerpt?: string;
}
export type Transport = (
  url: string,
  opts: { headers: Record<string, string>; body: string },
) => Promise<TransportResult>;

export interface DeliveryJob {
  deliveryId: string;
  subscription: { id: string; targetUrl: string; signingSecret: string };
  envelope: WebhookEnvelope;
  idempotencyKey: string;
}

export interface IWebhookDeliverer {
  enqueue(job: DeliveryJob): void;
}

function isTransient(status: number): boolean {
  if (status === 0) return true; // network error / timeout
  if (status >= 500) return true;
  return status === 408 || status === 429; // request timeout / too many requests
}

/** Real HTTP transport: POST with a hard timeout; non-2xx surfaces its status. */
export function fetchTransport(timeoutMs = 5000): Transport {
  return async (url, opts) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', headers: opts.headers, body: opts.body, signal: controller.signal });
      let excerpt = '';
      try {
        excerpt = (await res.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      return { status: res.status, bodyExcerpt: excerpt };
    } catch (e) {
      return { status: 0, bodyExcerpt: e instanceof Error ? e.message.slice(0, 500) : 'network error' };
    } finally {
      clearTimeout(t);
    }
  };
}

export class QueueWebhookDeliverer implements IWebhookDeliverer {
  constructor(
    private readonly deps: {
      clock: Clock;
      transport: Transport;
      /** Optional jitter (ms) added to each retry delay. Default 0 (deterministic). */
      jitter?: () => number;
    },
  ) {}

  enqueue(job: DeliveryJob): void {
    this.deps.clock.schedule(() => this.attempt(job, 1), 0);
  }

  private async attempt(job: DeliveryJob, n: number): Promise<void> {
    const startedMs = this.deps.clock.now();
    const body = JSON.stringify(job.envelope);
    const tSec = Math.floor(this.deps.clock.now() / 1000);
    const sig = signPayload(job.subscription.signingSecret, body, tSec);

    const result = await this.deps.transport(job.subscription.targetUrl, {
      headers: {
        'Content-Type': 'application/json',
        'Ship-Signature': sig.header,
        'Idempotency-Key': job.idempotencyKey,
      },
      body,
    });

    const latency = this.deps.clock.now() - startedMs;
    const ok = result.status >= 200 && result.status < 300;

    if (ok) {
      await updateDeliveryAttempt(job.deliveryId, {
        attemptNumber: n, status: 'delivered', responseStatus: result.status,
        responseExcerpt: result.bodyExcerpt ?? null, latencyMs: latency,
        nextAttemptAt: null, deliveredAt: new Date(this.deps.clock.now()),
      });
      return;
    }

    const transient = isTransient(result.status);
    if (!transient || n >= MAX_ATTEMPTS) {
      // permanent 4xx, or retries exhausted → dead-letter
      await updateDeliveryAttempt(job.deliveryId, {
        attemptNumber: n, status: 'dead', responseStatus: result.status,
        responseExcerpt: result.bodyExcerpt ?? null, latencyMs: latency, nextAttemptAt: null,
      });
      return;
    }

    // transient + retries remain → schedule the next attempt
    const delay = RETRY_DELAYS_MS[n - 1]! + (this.deps.jitter?.() ?? 0);
    await updateDeliveryAttempt(job.deliveryId, {
      attemptNumber: n, status: 'pending', responseStatus: result.status,
      responseExcerpt: result.bodyExcerpt ?? null, latencyMs: latency,
      nextAttemptAt: new Date(this.deps.clock.now() + delay),
    });
    this.deps.clock.schedule(() => this.attempt(job, n + 1), delay);
  }
}
