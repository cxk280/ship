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
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { signPayload, signPayloadEd25519, SHIP_SIGNATURE_ED25519_HEADER } from './signer.js';
import type { Clock } from './clock.js';
import type { WebhookEnvelope } from './events.js';
import { updateDeliveryAttempt, recordDeliveryFailure, recordDeliverySuccess } from './store.js';
import { assertPublicHttpUrl, allowPrivateTargets, isPrivateIp } from './url-guard.js';

export const RETRY_DELAYS_MS = [1000, 4000, 16000, 60_000, 300_000, 1_800_000];
export const MAX_ATTEMPTS = 6;

/**
 * Number of consecutive permanent delivery failures before a subscription is
 * auto-disabled.  A "permanent failure" is either a dead-lettered delivery
 * (all retry attempts exhausted) or a non-transient 4xx that skips retries
 * entirely.  Successful deliveries reset the counter to 0.
 */
export const AUTO_DISABLE_THRESHOLD = 15;

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
  /** Ed25519 private key PEM for the app; if present the delivery carries Ship-Signature-Ed25519 too. */
  ed25519PrivateKeyPem?: string;
}

export interface IWebhookDeliverer {
  enqueue(job: DeliveryJob): void;
}

export function isTransient(status: number): boolean {
  if (status === 0) return true; // network error / timeout
  if (status >= 500) return true;
  return status === 408 || status === 429; // request timeout / too many requests
}

/**
 * The retry/backoff schedule is NON-exponential (1s/4s/16s/1m/5m/30m), so any
 * queue backend (BullMQ, SQS) that wants native delayed-retry must map the
 * attempt number onto this table rather than a fixed multiplier. Returns the
 * delay (ms) to wait BEFORE attempt `n+1`, given that attempt `n` just failed.
 *
 * `n` is 1-based (the attempt that just ran). The first retry (after attempt 1)
 * waits RETRY_DELAYS_MS[0] = 1000ms. Returns 0 if no retry remains.
 */
export function backoffForAttempt(n: number): number {
  if (n < 1 || n >= MAX_ATTEMPTS) return 0;
  return RETRY_DELAYS_MS[n - 1] ?? 0;
}

/** Outcome of processing a single delivery attempt — drives the queue loop. */
export type AttemptOutcome =
  | { kind: 'delivered' }
  | { kind: 'dead' }
  | { kind: 'retry'; delayMs: number };

/**
 * Process ONE delivery attempt and persist its result. This is the single
 * source of truth for retry/DLQ semantics, shared by every IWebhookDeliverer
 * backend (in-memory queue + BullMQ/Redis) so they are observably identical:
 * same signing, same idempotency-key header, same transient/permanent
 * classification, same DLQ-after-MAX_ATTEMPTS, same failure-counter side
 * effects. The backend only decides HOW to wait between attempts.
 *
 * Returns an AttemptOutcome telling the caller whether to stop (delivered/dead)
 * or to re-enqueue after `delayMs` (retry). Mirrors QueueWebhookDeliverer.attempt
 * exactly; the in-memory deliverer below delegates to it.
 */
export async function processAttempt(
  job: DeliveryJob,
  n: number,
  deps: { clock: Clock; transport: Transport; jitter?: () => number },
): Promise<AttemptOutcome> {
  const startedMs = deps.clock.now();
  const body = JSON.stringify(job.envelope);
  const tSec = Math.floor(deps.clock.now() / 1000);
  const sig = signPayload(job.subscription.signingSecret, body, tSec);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Ship-Signature': sig.header,
    'Idempotency-Key': job.idempotencyKey,
  };

  // Dual-sign: add the Ed25519 header when the app has an active signing key
  // (B11). Lives here in the shared per-attempt path so EVERY deliverer backend
  // (in-memory + BullMQ) signs identically — the key PEM rides on the job.
  if (job.ed25519PrivateKeyPem) {
    const ed = signPayloadEd25519(job.ed25519PrivateKeyPem, body, tSec);
    headers[SHIP_SIGNATURE_ED25519_HEADER] = ed.header;
  }

  const result = await deps.transport(job.subscription.targetUrl, { headers, body });

  const latency = deps.clock.now() - startedMs;
  const ok = result.status >= 200 && result.status < 300;

  if (ok) {
    await updateDeliveryAttempt(job.deliveryId, {
      attemptNumber: n, status: 'delivered', responseStatus: result.status,
      responseExcerpt: result.bodyExcerpt ?? null, latencyMs: latency,
      nextAttemptAt: null, deliveredAt: new Date(deps.clock.now()),
    });
    await recordDeliverySuccess(job.subscription.id);
    return { kind: 'delivered' };
  }

  const transient = isTransient(result.status);
  if (!transient || n >= MAX_ATTEMPTS) {
    // permanent 4xx, or retries exhausted → dead-letter
    await updateDeliveryAttempt(job.deliveryId, {
      attemptNumber: n, status: 'dead', responseStatus: result.status,
      responseExcerpt: result.bodyExcerpt ?? null, latencyMs: latency, nextAttemptAt: null,
    });
    await recordDeliveryFailure(job.subscription.id, AUTO_DISABLE_THRESHOLD);
    return { kind: 'dead' };
  }

  // transient + retries remain → schedule the next attempt
  const delay = backoffForAttempt(n) + (deps.jitter?.() ?? 0);
  await updateDeliveryAttempt(job.deliveryId, {
    attemptNumber: n, status: 'pending', responseStatus: result.status,
    responseExcerpt: result.bodyExcerpt ?? null, latencyMs: latency,
    nextAttemptAt: new Date(deps.clock.now() + delay),
  });
  return { kind: 'retry', delayMs: delay };
}

/**
 * Real HTTP transport: POST with a hard timeout. To prevent DNS-rebinding SSRF,
 * production resolves the host ONCE, vets the address, then PINS the connection
 * to that exact IP (via a custom lookup) — the HTTP client never re-resolves, so
 * a domain can't return a public IP during validation and a private IP at connect
 * time. SNI/Host are preserved as the original hostname. Dev/test skips pinning so
 * localhost listeners (the TTFE drill) work.
 */
export function fetchTransport(timeoutMs = 5000): Transport {
  return async (rawUrl, opts) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { status: 400, bodyExcerpt: 'invalid target url' };
    }
    const allowPrivate = allowPrivateTargets();
    try {
      await assertPublicHttpUrl(rawUrl, { allowPrivate });
    } catch (e) {
      return { status: 403, bodyExcerpt: e instanceof Error ? e.message : 'target blocked' };
    }

    // Resolve once + vet, then pin (production only).
    let pinnedIp: string | undefined;
    let pinnedFamily = 4;
    // Only hostnames need pinning; IP literals were already vetted above.
    if (!allowPrivate && !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(':')) {
      try {
        const addrs = await dns.promises.lookup(url.hostname, { all: true });
        const ok = addrs.find((a) => !isPrivateIp(a.address));
        if (!ok) return { status: 403, bodyExcerpt: 'no public address for target' };
        pinnedIp = ok.address;
        pinnedFamily = ok.family;
      } catch {
        return { status: 403, bodyExcerpt: 'could not resolve target host' };
      }
    }

    const lib = url.protocol === 'https:' ? https : http;
    // Inline lookup (avoid importing a named type that differs across @types/node).
    const pinnedLookup = pinnedIp
      ? (_host: string, _options: unknown, cb: (err: Error | null, addr: string, fam: number) => void) =>
          cb(null, pinnedIp as string, pinnedFamily)
      : undefined;

    // Build options loosely so `lookup` (a net.connect option forwarded by
    // http.request) doesn't depend on a specific @types/node export.
    const reqOptions: http.RequestOptions = {
      method: 'POST',
      headers: { ...opts.headers, Host: url.host },
      timeout: timeoutMs,
      ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
    };
    if (pinnedLookup) (reqOptions as Record<string, unknown>).lookup = pinnedLookup;

    return await new Promise<TransportResult>((resolve) => {
      const req = lib.request(
        url,
        reqOptions,
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => {
            if (body.length < 500) body += c.toString('utf8');
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, bodyExcerpt: body.slice(0, 500) }));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, bodyExcerpt: 'timeout' });
      });
      req.on('error', (e: Error) => resolve({ status: 0, bodyExcerpt: e.message.slice(0, 500) }));
      req.write(opts.body);
      req.end();
    });
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
    // Delegate the retry/DLQ state machine to the shared processAttempt() so the
    // in-memory and BullMQ deliverers are observably identical; only the WAIT
    // mechanism differs (setTimeout-via-Clock here, Redis delayed jobs there).
    // processAttempt() also applies the B11 Ed25519 dual-signing path.
    const outcome = await processAttempt(job, n, this.deps);
    if (outcome.kind === 'retry') {
      this.deps.clock.schedule(() => this.attempt(job, n + 1), outcome.delayMs);
    }
  }
}
