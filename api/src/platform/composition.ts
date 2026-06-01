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
  const deps: PlatformDeps = {
    bearerAuth,
    identity: identityAdapter,
  };
  const v1Router = createV1Router(deps);
  return { v1Router };
}
