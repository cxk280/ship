/**
 * `require(scope)` — the authorization middleware factory.
 *
 * Reads the granted scopes off req.platformAuth (populated by the bearer-token
 * middleware) and 403s with the MISSING scope named explicitly — never an opaque
 * "forbidden" (PRD: "no opaque forbidden"). The factory validates the scope
 * against the registry at wiring time, so a typo fails fast at boot, not at runtime.
 */
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../errors.js';
import { scopeRegistry } from './registry.js';

export function requireScope(scope: string) {
  // Fail fast at composition time: a route may only require a registered scope.
  if (!scopeRegistry.has(scope)) {
    throw new Error(
      `requireScope("${scope}"): unknown scope. Register it in platform/scopes/registry.ts.`,
    );
  }

  return function requireScopeMiddleware(req: Request, _res: Response, next: NextFunction): void {
    // Stash the declared scope on the request so the audit middleware can read
    // which scope this route required — without coupling the audit layer to the
    // route-meta registry directly.
    (req as Request & { requiredScope?: string }).requiredScope = scope;

    const auth = req.platformAuth;
    if (!auth) {
      // Defensive: bearer auth must run before requireScope. Treat as unauthenticated.
      next(ApiError.unauthorized('Authentication required'));
      return;
    }
    if (!auth.scopes.includes(scope)) {
      next(
        ApiError.forbidden(`Missing required scope: ${scope}`, {
          required_scope: scope,
          granted_scopes: auth.scopes,
        }),
      );
      return;
    }
    next();
  };
}

/** The scope a route declares it needs. Attached to the route for the fitness test. */
export interface ScopedRoute {
  requiredScope: string;
}
