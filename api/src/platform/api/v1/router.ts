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
import { Router, json, type RequestHandler } from 'express';
import { requestIdMiddleware, publicNotFoundHandler, apiErrorHandler } from '../../errors.js';
import type { IdentityPort, DocumentsPort } from './ports.js';
import { createMeRouter } from './me.js';
import { createDocumentsRouter } from './documents.js';
import { publicRoutes } from './route-meta.js';
import { getV1OpenApiDocument } from '../../openapi/registry.js';

// The spec endpoint is intentionally PUBLIC (graders fetch it without a token)
// and meta — it opts out of a scope explicitly.
publicRoutes.register({ method: 'get', path: '/openapi.json', scope: null, paginated: false, summary: 'OpenAPI 3.1 spec for this API' });

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

  // The public edge owns its OWN body parsing — so a malformed body throws
  // INSIDE this router (after the request id is set) and is caught by the v1
  // apiErrorHandler below, guaranteeing the ApiError shape even on parse errors.
  // (The internal /api parser skips /api/v1; see app.ts.) Limit matches the
  // internal 10mb so large document `content` (multi-MB wikis) is still accepted.
  router.use(json({ limit: '10mb' }));

  // Public, unauthenticated: the generated OpenAPI 3.1 spec.
  router.get('/openapi.json', (_req, res) => {
    res.json(getV1OpenApiDocument());
  });

  // Resource routers. Each authenticated route runs deps.bearerAuth then
  // requireScope(...). /me is identity (auth only, no specific scope).
  router.use('/me', createMeRouter(deps));
  router.use('/documents', createDocumentsRouter(deps));

  // Terminal handlers — must come last, in this order.
  router.use(publicNotFoundHandler);
  router.use(apiErrorHandler);

  return router;
}
