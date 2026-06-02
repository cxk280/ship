/**
 * GET /api/v1/sprints — typed sprint resource (read-only).
 *
 * Sprints are documents with document_type='sprint'. Sprint creation involves
 * complex domain operations (approval workflows, accountability assignments)
 * that are risky to expose without careful domain modeling, so this resource
 * is intentionally read-only: GET list + GET /:id. Pipeline: bearer auth →
 * requireScope(sprints:read) → handler → SprintsPort.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ApiError } from '../../errors.js';
import { requireScope } from '../../scopes/require-scope.js';
import { SCOPES } from '../../scopes/registry.js';
import { publicRoutes } from './route-meta.js';
import { ListSprintsQuerySchema, SprintIdParamSchema } from './schemas.js';
import type { PlatformDeps } from './router.js';

/** Resolve the workspace the token operates in, or 403 if it has none. */
function requireWorkspace(req: Request): string {
  const ws = req.platformAuth?.workspaceId;
  if (!ws) throw ApiError.forbidden('This token is not scoped to a workspace');
  return ws;
}

// Self-register route contracts (read by OpenAPI generator + fitness test).
publicRoutes.register({ method: 'get', path: '/sprints', scope: SCOPES.SPRINTS_READ, paginated: true, summary: 'List sprints' });
publicRoutes.register({ method: 'get', path: '/sprints/{id}', scope: SCOPES.SPRINTS_READ, paginated: false, summary: 'Get a sprint by id' });

export function createSprintsRouter(deps: PlatformDeps): Router {
  const router = Router();

  // GET /api/v1/sprints — cursor-paginated list.
  router.get(
    '/',
    requireScope(SCOPES.SPRINTS_READ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const q = ListSprintsQuerySchema.parse(req.query);
        const page = await deps.sprints.list({
          workspaceId: requireWorkspace(req),
          limit: q.limit,
          cursor: q.cursor,
          status: q.status,
        });
        res.json(page);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/v1/sprints/:id
  router.get(
    '/:id',
    requireScope(SCOPES.SPRINTS_READ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = SprintIdParamSchema.parse(req.params);
        const sprint = await deps.sprints.get({
          workspaceId: requireWorkspace(req),
          id,
        });
        if (!sprint) throw ApiError.notFound('Sprint not found');
        res.json(sprint);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
