/**
 * The public `/api/v1` router.
 *
 * This is a BRAND-NEW router that shares NO request-handling middleware with the
 * internal `/api/*` API (no session auth, no conditional CSRF, no internal rate
 * limiter). Its pipeline is: request-id → bearer auth → [resource routes, each
 * declaring a scope] → 404 → public error handler.
 *
 * Boundary rule (enforced by scripts/check-api-boundary.mjs): files under
 * platform/api/v1/** must NOT import from api/src outside platform/. Concrete
 * collaborators (domain services, bearer auth) arrive via injected `deps`, wired
 * in the composition root (platform/composition.ts → app.ts).
 */
import { Router, type RequestHandler } from 'express';
import { requestIdMiddleware, publicNotFoundHandler, apiErrorHandler } from '../../errors.js';
import type { IdentityPort, DocumentsPort } from './ports.js';
import { createMeRouter } from './me.js';
import { createDocumentsRouter } from './documents.js';

/**
 * Collaborators injected by the composition root. Grows slice by slice
 * (bearer auth, domain services, event bus, rate limiter, …). Everything here is
 * an interface/port so the v1 layer never imports a concrete internal module.
 */
export interface PlatformDeps {
  /**
   * Bearer-token authentication for the public edge. Validates the OAuth access
   * token and populates req.platformAuth.
   */
  bearerAuth: RequestHandler;
  /** Identity lookups (e.g. for /me). */
  identity: IdentityPort;
  /** Documents domain operations. */
  documents: DocumentsPort;
}

export function createV1Router(deps: PlatformDeps): Router {
  const router = Router();

  // Every public request gets a request id (echoed as X-Request-Id, used by the
  // error middleware and audit trail).
  router.use(requestIdMiddleware);

  // Resource routers. Each authenticated route runs deps.bearerAuth then
  // requireScope(...). /me is identity (auth only, no specific scope).
  router.use('/me', createMeRouter(deps));
  router.use('/documents', createDocumentsRouter(deps));

  // Terminal handlers — must come last, in this order.
  router.use(publicNotFoundHandler);
  router.use(apiErrorHandler);

  return router;
}
