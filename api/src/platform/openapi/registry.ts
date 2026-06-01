/**
 * OpenAPI 3.1 generation for the public v1 API.
 *
 * The spec is GENERATED from route metadata + the Zod schemas next to the
 * handlers (platform/api/v1/schemas.ts) — never hand-written. Served live at
 * /api/v1/openapi.json and written to docs/openapi.json (static copy). A fitness
 * test asserts spec↔route parity so the spec cannot drift from the server.
 */
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import {
  ApiErrorSchema,
  PublicDocumentSchema,
  DocumentPageSchema,
  CreateDocumentSchema,
  ListDocumentsQuerySchema,
  DocumentIdParamSchema,
  MeResponseSchema,
} from '../api/v1/schemas.js';

const registry = new OpenAPIRegistry();

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'OAuth 2.0 access token (Authorization: Bearer <token>).',
});

// Register reusable component schemas.
registry.register('ApiError', ApiErrorSchema);
registry.register('Document', PublicDocumentSchema);
registry.register('DocumentPage', DocumentPageSchema);
registry.register('CreateDocument', CreateDocumentSchema);
registry.register('MeResponse', MeResponseSchema);

/** Shared error responses, each shaped as ApiError. */
function errorResponses(...codes: Array<401 | 403 | 404 | 400 | 429 | 500>) {
  const map: Record<number, string> = {
    400: 'Validation failed',
    401: 'Missing or invalid bearer token',
    403: 'Insufficient scope (names the missing scope)',
    404: 'Resource not found',
    429: 'Rate limited',
    500: 'Server error',
  };
  const out: Record<string, { description: string; content: Record<string, { schema: typeof ApiErrorSchema }> }> = {};
  for (const c of codes) {
    out[String(c)] = { description: map[c]!, content: { 'application/json': { schema: ApiErrorSchema } } };
  }
  return out;
}

// ---- paths ----------------------------------------------------------------

registry.registerPath({
  method: 'get',
  path: '/me',
  summary: 'Get the authenticated principal',
  tags: ['identity'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: 'The authenticated user/app', content: { 'application/json': { schema: MeResponseSchema } } },
    ...errorResponses(401),
  },
});

registry.registerPath({
  method: 'get',
  path: '/documents',
  summary: 'List documents',
  tags: ['documents'],
  security: [{ bearerAuth: [] }],
  request: { query: ListDocumentsQuerySchema },
  responses: {
    200: { description: 'A page of documents', content: { 'application/json': { schema: DocumentPageSchema } } },
    ...errorResponses(400, 401, 403),
  },
});

registry.registerPath({
  method: 'get',
  path: '/documents/{id}',
  summary: 'Get a document by id',
  tags: ['documents'],
  security: [{ bearerAuth: [] }],
  request: { params: DocumentIdParamSchema },
  responses: {
    200: { description: 'The document', content: { 'application/json': { schema: PublicDocumentSchema } } },
    ...errorResponses(400, 401, 403, 404),
  },
});

registry.registerPath({
  method: 'post',
  path: '/documents',
  summary: 'Create a document',
  tags: ['documents'],
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: CreateDocumentSchema } } } },
  responses: {
    201: { description: 'The created document', content: { 'application/json': { schema: PublicDocumentSchema } } },
    ...errorResponses(400, 401, 403),
  },
});

let cached: OpenAPIObject | null = null;

/** Generate (and cache) the OpenAPI 3.1 document for the public API. */
export function getV1OpenApiDocument(): OpenAPIObject {
  if (cached) return cached;
  const generator = new OpenApiGeneratorV31(registry.definitions);
  cached = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Ship Public API',
      version: '1.0.0',
      description:
        'Plugforge — the versioned public API for Ship. OAuth 2.0 bearer auth, ' +
        'granular scopes, opaque cursor pagination, and a consistent ApiError shape.',
    },
    servers: [{ url: '/api/v1', description: 'Public API base path' }],
    security: [{ bearerAuth: [] }],
  }) as OpenAPIObject;
  return cached;
}
