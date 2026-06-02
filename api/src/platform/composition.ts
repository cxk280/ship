/**
 * Platform composition root (helper).
 *
 * This module is where the public platform graph is wired: concrete
 * implementations (bearer auth, domain services, event bus, webhook deliverer,
 * rate limiter) are constructed and injected into the `/api/v1` router. It is the
 * ONE place allowed to know both the public ports and the concrete internal
 * collaborators — so platform/api/v1/** stays free of internal imports.
 *
 * app.ts (the canonical composition root, per docs/architecture.md) calls
 * `buildPlatform()` and mounts the returned router at `/api/v1`.
 */
import type { Router } from 'express';
import { createV1Router, type PlatformDeps } from './api/v1/router.js';
import { bearerAuth } from './oauth/bearer.js';
import { identityAdapter } from './adapters/identity.js';
import { createDocumentsAdapter } from './adapters/documents.js';
import { createIssuesAdapter } from './adapters/issues.js';
import { createSprintsAdapter } from './adapters/sprints.js';
import { createWebhooksAdapter } from './adapters/webhooks.js';
import { createAuditAdapter } from './adapters/audit.js';
import { InMemoryTokenBucketLimiter } from './ratelimit/limiter.js';
import { createRateLimitMiddleware } from './ratelimit/middleware.js';
import { systemClock } from './webhooks/clock.js';
import { QueueWebhookDeliverer, fetchTransport } from './webhooks/deliverer.js';
import { InMemoryEventBus } from './webhooks/event-bus.js';

// Import './types.js' for its side-effecting Express.Request augmentation
// (requestId, platformAuth) so every consumer sees the public-edge fields.
import './types.js';

export interface Platform {
  /** The public `/api/v1` router, ready to mount. */
  v1Router: Router;
}

/**
 * Build the platform with production (in-memory must-ship) implementations.
 *
 * Grows slice by slice. Today it wires the foundation; OAuth bearer auth, domain
 * services, and the webhook pipeline are added in their respective slices. An
 * in-memory test wiring (the sibling diagram in docs/architecture.md) will swap
 * these deps for deterministic doubles.
 */
export function buildPlatform(): Platform {
  // In test/dev, use very high limits so suites and local work don't trip 429s;
  // production gets real token-bucket limits (per-token tighter than per-app).
  const relaxed = process.env.NODE_ENV === 'test' || process.env.E2E_TEST === '1';
  const perToken = relaxed
    ? new InMemoryTokenBucketLimiter(100_000, 100_000)
    : new InMemoryTokenBucketLimiter(120, 2); // 120 burst, ~120/min sustained
  const perApp = relaxed
    ? new InMemoryTokenBucketLimiter(100_000, 100_000)
    : new InMemoryTokenBucketLimiter(600, 10); // 600 burst, ~600/min sustained

  // Webhook pipeline: domain writes → event bus → deliverer (retry/DLQ). Jitter is
  // applied in production only (kept at 0 under test for determinism).
  const deliverer = new QueueWebhookDeliverer({
    clock: systemClock,
    transport: fetchTransport(),
    jitter: relaxed ? () => 0 : () => Math.floor(Math.random() * 1000),
  });
  const eventBus = new InMemoryEventBus({ deliverer, clock: systemClock });

  const deps: PlatformDeps = {
    bearerAuth,
    rateLimit: createRateLimitMiddleware({ perToken, perApp }),
    identity: identityAdapter,
    documents: createDocumentsAdapter(eventBus),
    issues: createIssuesAdapter(eventBus),
    sprints: createSprintsAdapter(),
    webhooks: createWebhooksAdapter(eventBus),
    audit: createAuditAdapter(),
  };
  const v1Router = createV1Router(deps);
  return { v1Router };
}
