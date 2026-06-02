/**
 * GET/POST /api/v1/issues — typed issue resource.
 *
 * Issues are documents with document_type='issue'. This resource exposes a
 * filtered, opinionated view: cursor-paginated list, single-get, and create.
 * Pipeline: bearer auth → requireScope(issues:*) → handler → IssuesPort.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ApiError } from '../../errors.js';
import { requireScope } from '../../scopes/require-scope.js';
import { SCOPES } from '../../scopes/registry.js';
import { publicRoutes } from './route-meta.js';
import { ListIssuesQuerySchema, CreateIssueSchema, IssueIdParamSchema } from './schemas.js';
import type { PlatformDeps } from './router.js';

/** Resolve the workspace the token operates in, or 403 if it has none. */
function requireWorkspace(req: Request): string {
  const ws = req.platformAuth?.workspaceId;
  if (!ws) throw ApiError.forbidden('This token is not scoped to a workspace');
  return ws;
}

// Self-register route contracts (read by OpenAPI generator + fitness test).
publicRoutes.register({ method: 'get', path: '/issues', scope: SCOPES.ISSUES_READ, paginated: true, summary: 'List issues' });
publicRoutes.register({ method: 'get', path: '/issues/{id}', scope: SCOPES.ISSUES_READ, paginated: false, summary: 'Get an issue by id' });
publicRoutes.register({ method: 'post', path: '/issues', scope: SCOPES.ISSUES_WRITE, paginated: false, summary: 'Create an issue' });

export function createIssuesRouter(deps: PlatformDeps): Router {
  const router = Router();

  // GET /api/v1/issues — cursor-paginated list.
  router.get(
    '/',
    requireScope(SCOPES.ISSUES_READ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const q = ListIssuesQuerySchema.parse(req.query);
        const page = await deps.issues.list({
          workspaceId: requireWorkspace(req),
          limit: q.limit,
          cursor: q.cursor,
          state: q.state,
          priority: q.priority,
          assignee_id: q.assignee_id,
        });
        res.json(page);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/v1/issues/:id
  router.get(
    '/:id',
    requireScope(SCOPES.ISSUES_READ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = IssueIdParamSchema.parse(req.params);
        const issue = await deps.issues.get({
          workspaceId: requireWorkspace(req),
          id,
        });
        if (!issue) throw ApiError.notFound('Issue not found');
        res.json(issue);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/v1/issues
  router.post(
    '/',
    requireScope(SCOPES.ISSUES_WRITE),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = CreateIssueSchema.parse(req.body);
        const issue = await deps.issues.create({
          workspaceId: requireWorkspace(req),
          createdBy: req.platformAuth?.userId ?? null,
          title: body.title,
          state: body.state,
          priority: body.priority,
          properties: {
            ...(body.properties ?? {}),
            ...(body.assignee_id !== undefined ? { assignee_id: body.assignee_id } : {}),
            ...(body.due_date !== undefined ? { due_date: body.due_date } : {}),
          },
        });
        res.status(201).json(issue);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
