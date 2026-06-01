/**
 * Concrete DocumentsPort — bridges the public edge to the documents domain core
 * and owns the opaque-cursor translation. Lives under platform/adapters (not
 * api/v1), so it may import the internal domain service. Injected by composition.
 */
import { documentsDomain, type DomainDocument } from '../../domain/documents.js';
import { encodeCursor, decodeCursor } from '../cursor.js';
import type { IEventBus } from '../webhooks/event-bus.js';
import type { DocumentsPort, PublicDocument, Page } from '../api/v1/ports.js';

function toPublic(d: DomainDocument): PublicDocument {
  return {
    id: d.id,
    document_type: d.document_type,
    title: d.title,
    content: d.content,
    properties: d.properties ?? {},
    parent_id: d.parent_id,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

/**
 * The documents adapter is built with the event bus so a create PUBLISHES
 * document.created — the domain write is where events originate (never the route
 * layer). A publish failure is logged, never failing the write itself.
 */
export function createDocumentsAdapter(eventBus: IEventBus): DocumentsPort {
  return {
  async list(input): Promise<Page<PublicDocument>> {
    const after = decodeCursor(input.cursor);
    const result = await documentsDomain.list({
      workspaceId: input.workspaceId,
      limit: input.limit,
      after: after ? { createdAt: after.ts, id: after.id } : null,
      documentType: input.documentType,
    });
    return {
      data: result.items.map(toPublic),
      next_cursor: result.nextKeyset
        ? encodeCursor({ id: result.nextKeyset.id, ts: result.nextKeyset.createdAt })
        : null,
    };
  },

  async get(input): Promise<PublicDocument | null> {
    const doc = await documentsDomain.get(input);
    return doc ? toPublic(doc) : null;
  },

  async create(input): Promise<PublicDocument> {
    const doc = await documentsDomain.create({
      workspaceId: input.workspaceId,
      createdBy: input.createdBy,
      title: input.title,
      documentType: input.documentType,
      content: input.content,
      properties: input.properties,
    });
    // Publish document.created on the write. Never fail the write if delivery
    // bookkeeping hiccups — the document was created either way.
    try {
      await eventBus.publish({
        type: 'document.created',
        workspaceId: doc.workspace_id,
        data: {
          id: doc.id,
          document_type: doc.document_type,
          title: doc.title,
          workspace_id: doc.workspace_id,
        },
      });
    } catch (err) {
      console.error('[webhooks] failed to publish document.created:', err);
    }
    return toPublic(doc);
  },
  };
}
