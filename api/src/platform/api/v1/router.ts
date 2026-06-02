/**
 * The public `/api/v1` router.
 *
 * This is a BRAND-NEW router that shares NO request-handling middleware with the
 * internal `/api/*` API (no session auth, no conditional CSRF, no internal rate
 * limiter). Its pipeline is: request-id → audit → json parser → bearer auth →
 * rate-limit → idempotency → [resource routes, each declaring a scope] → 404 →
 * public error handler.
 *
 * Boundary rule (enforced by scripts/check-api-boundary.mjs): files under
 * platform/api/v1/** must NOT import from api/src outside platform/. Concrete
 * collaborators (domain services, bearer auth) arrive via injected `deps`, wired
 * in the composition root (platform/composition.ts → app.ts).
 */
import { Router, json, type RequestHandler, type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'crypto';
import { requestIdMiddleware, publicNotFoundHandler, apiErrorHandler, ApiError } from '../../errors.js';
import type { IdentityPort, DocumentsPort, IssuesPort, SprintsPort, WebhooksPort, AuditPort, IdempotencyPort } from './ports.js';
import { createMeRouter } from './me.js';
import { createDocumentsRouter } from './documents.js';
import { createIssuesRouter } from './issues.js';
import { createSprintsRouter } from './sprints.js';
import { createWebhooksRouter } from './webhooks.js';
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
  /** Per-app + per-token rate limiting for the public edge. */
  rateLimit: RequestHandler;
  /** Identity lookups (e.g. for /me). */
  identity: IdentityPort;
  /** Documents domain operations. */
  documents: DocumentsPort;
  /** Issues domain operations. */
  issues: IssuesPort;
  /** Sprints domain operations (read-only). */
  sprints: SprintsPort;
  /** Webhook subscription management + delivery log + replay. */
  webhooks: WebhooksPort;
  /** Per-call audit trail — fire-and-forget, must not throw. */
  audit: AuditPort;
  /** Idempotency store — exactly-once semantics for POST writes. */
  idempotency: IdempotencyPort;
}

/**
 * Build the audit middleware. Runs immediately after request-id so every public
 * request installs the finish listener, including malformed bodies and auth
 * failures. Authenticated requests populate req.platformAuth later in the
 * pipeline; unauthenticated failures are recorded with null app/user fields.
 */
function createAuditMiddleware(audit: AuditPort): RequestHandler {
  return function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startMs = Date.now();
    res.on('finish', () => {
      try {
        const auth = req.platformAuth;
        // Determine the route template. Express sets req.route.path on the
        // matched route; combined with req.baseUrl it gives e.g. /documents/:id.
        // Fall back to req.path for middleware-level 404s.
        const routeTemplate = req.route?.path
          ? `${req.baseUrl}${req.route.path}`.replace(/\/api\/v1/, '') || req.route.path
          : req.path;

        // The requireScope middleware stashes the declared scope on req so we
        // can report exactly which scope the matched route required.
        const scope = (req as Request & { requiredScope?: string }).requiredScope ?? null;

        audit.record({
          requestId: req.requestId ?? '',
          method: req.method,
          route: routeTemplate,
          status: res.statusCode,
          latencyMs: Date.now() - startMs,
          scope,
          appId: auth?.appId ?? null,
          clientId: auth?.clientId ?? null,
          userId: auth?.userId ?? null,
          workspaceId: auth?.workspaceId ?? null,
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        });
      } catch {
        // Audit must never leak into the request path.
      }
    });
    next();
  };
}

/**
 * Compute a stable fingerprint for a request: sha256 of method + originalUrl +
 * deterministically-serialized body.  Used by the idempotency middleware to
 * detect key reuse with a different payload.
 */
function requestFingerprint(method: string, url: string, body: unknown): string {
  const stable = JSON.stringify(body, Object.keys(body && typeof body === 'object' ? (body as Record<string, unknown>) : {}).sort());
  return createHash('sha256').update(`${method}:${url}:${stable}`).digest('hex');
}

/**
 * Idempotency middleware — Stripe-grade exactly-once semantics for POST writes.
 *
 * Only activates when:
 *   - req.method === 'POST'
 *   - The `Idempotency-Key` header is present
 *
 * Requires `deps.bearerAuth` to have already run so `req.platformAuth.appId` is
 * available. Wire this AFTER bearerAuth + rateLimit.
 *
 * Fails OPEN: if the store throws unexpectedly, we log + call next() rather than
 * blocking the write.
 */
function createIdempotencyMiddleware(store: IdempotencyPort): RequestHandler {
  return async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Only POST writes opt in to idempotency.
    if (req.method !== 'POST') {
      next();
      return;
    }

    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      next();
      return;
    }

    const appId = req.platformAuth?.appId;
    if (!appId) {
      // bearerAuth should have rejected unauthenticated requests before we get
      // here, but defend against misconfiguration.
      next();
      return;
    }

    const fingerprint = requestFingerprint(req.method, req.originalUrl, req.body);

    let result;
    try {
      result = await store.begin({ appId, key, fingerprint });
    } catch (err) {
      // Fail open: store hiccup must never block a write.
      console.error('[idempotency] store.begin threw — failing open:', err);
      next();
      return;
    }

    if (result.kind === 'replay') {
      res.setHeader('Idempotency-Replayed', 'true');
      res.status(result.record.status).json(result.record.body);
      return;
    }

    if (result.kind === 'conflict') {
      // 409 with validation_failed code: the same key is in-flight concurrently.
      // We use the fixed validation_failed code (no new codes allowed) but override
      // the HTTP status directly so clients can distinguish conflict from a generic
      // 400.  We call res.json() directly rather than next(err) to control the
      // status without mutating ApiError.
      const conflictErr = ApiError.validation('A request with this Idempotency-Key is already in progress');
      res.status(409).json(conflictErr.toBody(req.requestId ?? ''));
      return;
    }

    if (result.kind === 'mismatch') {
      // 422: same key, different payload.
      const mismatchErr = ApiError.validation('Idempotency-Key was reused with a different request');
      res.status(422).json(mismatchErr.toBody(req.requestId ?? ''));
      return;
    }

    // result.kind === 'new': monkeypatch res.json to capture the 2xx response
    // and persist it, then signal the header so callers can detect replays.
    res.setHeader('Idempotency-Replayed', 'false');
    const originalJson = res.json.bind(res);
    res.json = function captureJson(body: unknown) {
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        // Fire-and-forget — never block the response.
        store.complete({ appId, key, status, body }).catch((err: unknown) => {
          console.error('[idempotency] store.complete threw:', err);
        });
      }
      return originalJson(body);
    };

    next();
  };
}

export function createV1Router(deps: PlatformDeps): Router {
  const router = Router();

  // Every public request gets a request id (echoed as X-Request-Id, used by the
  // error middleware and audit trail).
  router.use(requestIdMiddleware);

  // Install audit before parsing/auth so malformed bodies and authentication
  // failures still produce a public API call audit row.
  router.use(createAuditMiddleware(deps.audit));

  // The public edge owns its OWN body parsing — so a malformed body throws
  // INSIDE this router (after the request id is set) and is caught by the v1
  // apiErrorHandler below, guaranteeing the ApiError shape even on parse errors.
  // (The internal /api parser skips /api/v1; see app.ts.) Limit matches the
  // internal 10mb so large document `content` (multi-MB wikis) is still accepted.
  router.use(json({ limit: '10mb' }));

  // Public, unauthenticated: the generated OpenAPI 3.1 spec (must stay reachable
  // without a token, so it sits BEFORE the auth + rate-limit gate).
  router.get('/openapi.json', (_req, res) => {
    res.json(getV1OpenApiDocument());
  });

  // The public-edge gate, applied to every resource route in one place (the deck's
  // chain): authN → rate-limit → idempotency → [requireScope per route] → handler.
  // Keeping it here (not per-route) is why a route can't accidentally ship
  // unauthenticated or unthrottled.
  router.use(deps.bearerAuth);

  router.use(deps.rateLimit);

  // Idempotency sits AFTER auth (needs appId) and BEFORE resource routers.
  router.use(createIdempotencyMiddleware(deps.idempotency));

  // Resource routers. Each route declares its scope via requireScope(...); /me is
  // identity (auth only, no specific scope).
  router.use('/me', createMeRouter(deps));
  router.use('/documents', createDocumentsRouter(deps));
  router.use('/issues', createIssuesRouter(deps));
  router.use('/sprints', createSprintsRouter(deps));
  router.use('/webhooks', createWebhooksRouter(deps));

  // Terminal handlers — must come last, in this order.
  router.use(publicNotFoundHandler);
  router.use(apiErrorHandler);

  return router;
}
