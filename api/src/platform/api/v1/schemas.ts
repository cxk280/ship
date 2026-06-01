/**
 * Zod schemas for the public v1 API — the SINGLE source for both request
 * validation (handlers .parse() these) and OpenAPI generation (the generator
 * walks the same objects). This co-location is what makes spec↔route parity
 * real: the spec can't drift from the validation because they're the same Zod.
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const DOC_TYPES = ['wiki', 'issue', 'program', 'project', 'sprint', 'person'] as const;

/** The public error contract (mirrors platform/errors.ts ApiError). */
export const ApiErrorSchema = z
  .object({
    code: z.enum([
      'unauthorized',
      'forbidden',
      'not_found',
      'validation_failed',
      'rate_limited',
      'server_error',
    ]),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
    request_id: z.string(),
  })
  .openapi('ApiError');

export const PublicDocumentSchema = z
  .object({
    id: z.string().uuid(),
    document_type: z.string(),
    title: z.string(),
    content: z.unknown().optional(),
    properties: z.record(z.unknown()),
    parent_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('Document');

export const DocumentPageSchema = z
  .object({
    data: z.array(PublicDocumentSchema),
    next_cursor: z.string().nullable().openapi({ description: 'Opaque cursor to the next page, or null at the end.' }),
  })
  .openapi('DocumentPage');

export const CreateDocumentSchema = z
  .object({
    title: z.string().min(1).max(255).default('Untitled'),
    document_type: z.enum(DOC_TYPES).default('wiki'),
    content: z.unknown().optional(),
    properties: z.record(z.unknown()).optional(),
  })
  .openapi('CreateDocument');

/** Path param for /documents/{id} — same UUID rule the OpenAPI spec declares. */
export const DocumentIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const ListDocumentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
  document_type: z.enum(DOC_TYPES).optional(),
});

export const WEBHOOK_EVENT_TYPES = [
  'document.created', 'document.updated', 'document.deleted',
  'issue.created', 'issue.assigned', 'issue.status_changed',
  'sprint.started', 'sprint.completed',
] as const;

export const CreateSubscriptionSchema = z
  .object({
    event_type: z.enum(WEBHOOK_EVENT_TYPES),
    target_url: z.string().url(),
  })
  .openapi('CreateSubscription');

export const SubscriptionSchema = z
  .object({
    id: z.string().uuid(),
    event_type: z.string(),
    target_url: z.string(),
    active: z.boolean(),
    created_at: z.string(),
  })
  .openapi('WebhookSubscription');

export const DeliverySchema = z
  .object({
    id: z.string().uuid(),
    event_type: z.string(),
    attempt_number: z.number().int(),
    status: z.string(),
    response_status: z.number().int().nullable(),
    latency_ms: z.number().int().nullable(),
    idempotency_key: z.string(),
    created_at: z.string(),
  })
  .openapi('WebhookDelivery');

/** The 201 body — includes the one-time signing_secret a client must capture. */
export const CreatedSubscriptionSchema = SubscriptionSchema.extend({
  signing_secret: z.string().openapi({ description: 'Shown once. Save it to verify deliveries.' }),
  warning: z.string(),
}).openapi('CreatedWebhookSubscription');

export const SubscriptionIdParamSchema = z.object({ id: z.string().uuid() });
export const DeliveryIdParamSchema = z.object({ id: z.string().uuid() });

export const MeResponseSchema = z
  .object({
    user: z
      .object({ id: z.string(), email: z.string(), name: z.string() })
      .nullable(),
    app: z.object({ client_id: z.string() }),
    scopes: z.array(z.string()),
    workspace_id: z.string().nullable(),
  })
  .openapi('MeResponse');
