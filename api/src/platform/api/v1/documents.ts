/**
 * GET/POST /api/v1/documents — the first public resource.
 *
 * Each route runs deps.bearerAuth → requireScope(...) → handler. List is cursor
 * paginated and returns { data, next_cursor }. Failures ship the ApiError shape
 * (via the edge error middleware). Contracts self-register in the route registry.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ApiError } from '../../errors.js';
import { requireScope } from '../../scopes/require-scope.js';
import { SCOPES } from '../../scopes/registry.js';
import { publicRoutes } from './route-meta.js';
import { ListDocumentsQuerySchema, CreateDocumentSchema, DocumentIdParamSchema } from './schemas.js';
import type { PlatformDeps } from './router.js';

/** Resolve the workspace the token operates in, or 403 if it has none. */
function requireWorkspace(req: Request): string {
  const ws = req.platformAuth?.workspaceId;
  if (!ws) throw ApiError.forbidden('This token is not scoped to a workspace');
  return ws;
}

// Self-register route contracts (read by OpenAPI generator + fitness test).
publicRoutes.register({ method: 'get', path: '/documents', scope: SCOPES.DOCUMENTS_READ, paginated: true, summary: 'List documents' });
publicRoutes.register({ method: 'get', path: '/documents/{id}', scope: SCOPES.DOCUMENTS_READ, paginated: false, summary: 'Get a document by id' });
publicRoutes.register({ method: 'post', path: '/documents', scope: SCOPES.DOCUMENTS_WRITE, paginated: false, summary: 'Create a document' });

export function createDocumentsRouter(deps: PlatformDeps): Router {
  const router = Router();

  // GET /api/v1/documents — cursor-paginated list.
  router.get(
    '/',
    deps.bearerAuth,
    requireScope(SCOPES.DOCUMENTS_READ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const q = ListDocumentsQuerySchema.parse(req.query);
        const page = await deps.documents.list({
          workspaceId: requireWorkspace(req),
          limit: q.limit,
          cursor: q.cursor,
          documentType: q.document_type,
        });
        res.json(page);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/v1/documents/:id
  router.get(
    '/:id',
    deps.bearerAuth,
    requireScope(SCOPES.DOCUMENTS_READ),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Validate the path param against the SAME schema the OpenAPI declares
        // (UUID). A non-UUID id is a client error (400), not a 500 from Postgres.
        const { id } = DocumentIdParamSchema.parse(req.params);
        const doc = await deps.documents.get({
          workspaceId: requireWorkspace(req),
          id,
        });
        if (!doc) throw ApiError.notFound('Document not found');
        res.json(doc);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/v1/documents
  router.post(
    '/',
    deps.bearerAuth,
    requireScope(SCOPES.DOCUMENTS_WRITE),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = CreateDocumentSchema.parse(req.body);
        const doc = await deps.documents.create({
          workspaceId: requireWorkspace(req),
          createdBy: req.platformAuth?.userId ?? null,
          title: body.title,
          documentType: body.document_type,
          content: body.content,
          properties: body.properties,
        });
        res.status(201).json(doc);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
