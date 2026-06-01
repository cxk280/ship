/**
 * The public `/api/v1` router.
 *
 * This is a BRAND-NEW router that shares NO request-handling middleware with the
 * internal `/api/*` API (no session auth, no conditional CSRF, no internal rate
 * limiter). Its pipeline is: request-id → body parsers → bearer auth →
 * [resource routes, each declaring a scope] → 404 → public error handler.
 *
 * Boundary rule (enforced by scripts/check-api-boundary.mjs): files under
 * platform/api/v1/** must NOT import from api/src outside platform/. Concrete
 * collaborators (domain services, bearer auth) arrive via injected `deps`, wired
 * in the composition root (platform/composition.ts → app.ts).
 */
import express, { Router, type RequestHandler } from 'express';
import { requestIdMiddleware, publicNotFoundHandler, apiErrorHandler } from '../../errors.js';

/**
 * Collaborators injected by the composition root. Grows slice by slice
 * (bearer auth, domain services, event bus, rate limiter, …). Everything here is
 * an interface/port so the v1 layer never imports a concrete internal module.
 */
export interface PlatformDeps {
  /**
   * Bearer-token authentication for the public edge. Validates the OAuth access
   * token and populates req.platformAuth. Injected in Slice 2; when absent (early
   * foundation), the edge has no authenticated routes mounted yet.
   */
  bearerAuth?: RequestHandler;
}

export function createV1Router(_deps: PlatformDeps = {}): Router {
  const router = Router();

  // Every public request gets a request id (echoed as X-Request-Id, used by the
  // error middleware and audit trail).
  router.use(requestIdMiddleware);

  // Public body parsing belongs inside this router so parse failures still flow
  // through the ApiError contract instead of Express's default error response.
  router.use(express.json({ limit: '10mb' }));
  router.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Resource routers are mounted here in later slices, e.g.:
  //   router.use('/me', createMeRouter(deps));
  //   router.use('/documents', createDocumentsRouter(deps));
  // Each authenticated route runs deps.bearerAuth then requireScope(...).

  // Terminal handlers — must come last, in this order.
  router.use(publicNotFoundHandler);
  router.use(apiErrorHandler);

  return router;
}
