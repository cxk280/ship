/**
 * BullMQ/Redis webhook deliverer — a Liskov drop-in for IWebhookDeliverer.
 *
 * This implements the EXACT same observable contract as QueueWebhookDeliverer
 * (the in-memory must-ship impl): same 1s/4s/16s/1m/5m retry schedule, same
 * dead-letter-after-MAX_ATTEMPTS behavior, same idempotency-key preservation on
 * replay, same SSRF-hardened transport, same signer, same failure-counter side
 * effects. It does NOT reimplement any of that — the per-attempt state machine
 * lives in `processAttempt()` in deliverer.ts and is shared verbatim. The ONLY
 * thing that differs is HOW we wait between attempts: instead of a setTimeout
 * driven by the injected Clock, we hand the wait to BullMQ/Redis as a delayed
 * job. This is the seam the locked architecture decision is about: swap the
 * backend, keep the semantics, change no callers.
 *
 * The retry schedule is NON-exponential, so we cannot use BullMQ's built-in
 * 'exponential'/'fixed' backoff. Instead we run with `attempts: 1` per job and
 * RE-ENQUEUE the next attempt ourselves with an explicit `delay` computed by the
 * shared `backoffForAttempt(n)` — that keeps the delay table in ONE place
 * (deliverer.ts) and guarantees parity with the in-memory deliverer. (A custom
 * BullMQ backoff strategy reading the attempt number would also work; explicit
 * re-enqueue is simpler and keeps the DLQ decision in our shared code rather
 * than splitting it between our handler and BullMQ's attempts-exhausted path.)
 *
 * bullmq + ioredis are runtime deps of @ship/api ONLY. They are imported here,
 * deep inside the platform internals, and never cross the api/v1 public boundary
 * or leak into @ship/sdk (which is zero-runtime-deps). The composition root
 * selects this impl via env; the default deploy never imports this file.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { Clock } from './clock.js';
import {
  type DeliveryJob,
  type IWebhookDeliverer,
  type Transport,
  processAttempt,
} from './deliverer.js';

/** The job payload BullMQ persists in Redis: the delivery job + which attempt. */
interface BullMqJobData {
  job: DeliveryJob;
  attempt: number; // 1-based attempt number this job represents
}

const QUEUE_NAME = 'webhook-deliveries';

export interface BullMqDelivererDeps {
  /**
   * Redis connection: either a URL string (e.g. process.env.REDIS_URL) or a
   * pre-built ioredis client (tests inject ioredis-mock here). When a URL is
   * given we build the client with `maxRetriesPerRequest: null`, which BullMQ
   * requires for its blocking Worker connection.
   */
  connection: string | Redis;
  /** SSRF-hardened transport — the SAME fetchTransport() the in-memory impl uses. */
  transport: Transport;
  /** Clock for signing timestamps + latency. systemClock in prod; TestClock in tests. */
  clock: Clock;
  /** Optional retry jitter (ms). Default 0. */
  jitter?: () => number;
  /** Override the queue name (test isolation). Defaults to 'webhook-deliveries'. */
  queueName?: string;
  /** Worker concurrency. Default 5. */
  concurrency?: number;
}

// Job result type is void; the queue/worker generics default the rest.
type WebhookQueue = Queue<BullMqJobData, void, string>;
type WebhookWorker = Worker<BullMqJobData, void, string>;

export class BullMqWebhookDeliverer implements IWebhookDeliverer {
  private readonly queue: WebhookQueue;
  private readonly worker: WebhookWorker;
  private readonly queueName: string;
  /** Set only when WE created the ioredis client (URL form), so close() owns it. */
  private readonly ownedConnection?: Redis;

  constructor(private readonly deps: BullMqDelivererDeps) {
    this.queueName = deps.queueName ?? QUEUE_NAME;
    const connection: Redis =
      typeof deps.connection === 'string'
        ? (this.ownedConnection = new Redis(deps.connection, { maxRetriesPerRequest: null }))
        : deps.connection;
    this.queue = new Queue<BullMqJobData, void, string>(this.queueName, {
      connection,
      defaultJobOptions: {
        // We manage retries ourselves (explicit re-enqueue with our delay table),
        // so each job is a single attempt. Clean up finished jobs to bound Redis.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 1000,
      },
    });
    this.worker = new Worker<BullMqJobData, void, string>(
      this.queueName,
      (bullJob) => this.process(bullJob),
      { connection, concurrency: deps.concurrency ?? 5 },
    );
  }

  /** IWebhookDeliverer: enqueue attempt #1 with no delay. */
  enqueue(job: DeliveryJob): void {
    // Fire-and-forget to match the in-memory deliverer's synchronous signature.
    // Errors are swallowed the same way a failed setTimeout schedule would be —
    // the delivery row stays 'pending' and can be replayed.
    void this.queue.add(
      'deliver',
      { job, attempt: 1 },
      { delay: 0 },
    );
  }

  /**
   * Worker handler: run ONE attempt via the shared state machine, then either
   * stop (delivered/dead) or re-enqueue the next attempt with the backoff delay
   * that the in-memory deliverer would have slept. Redis holds the delay, so the
   * retry "survives" a process restart — the one property the in-memory queue
   * can't offer — without changing any observable semantics.
   */
  private async process(bullJob: Job<BullMqJobData, void, string>): Promise<void> {
    const { job, attempt } = bullJob.data;
    const outcome = await processAttempt(job, attempt, {
      clock: this.deps.clock,
      transport: this.deps.transport,
      jitter: this.deps.jitter,
    });
    if (outcome.kind === 'retry') {
      await this.queue.add(
        'deliver',
        { job, attempt: attempt + 1 },
        { delay: outcome.delayMs },
      );
    }
  }

  /** Graceful shutdown — close the worker then the queue (drains in-flight work). */
  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    if (this.ownedConnection) await this.ownedConnection.quit();
  }
}
