/**
 * Concrete DocumentsPort — bridges the public edge to the documents domain core
 * and owns the opaque-cursor translation. Lives under platform/adapters (not
 * api/v1), so it may import the internal domain service. Injected by composition.
 */
import { documentsDomain, type DomainDocument } from '../../domain/documents.js';
import { encodeCursor, decodeCursor } from '../cursor.js';
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

export const documentsAdapter: DocumentsPort = {
  async list(input): Promise<Page<PublicDocument>> {
    const after = decodeCursor(input.cursor);
    const result = await documentsDomain.list({
      workspaceId: input.workspaceId,
      viewerUserId: input.viewerUserId,
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
    const doc = await documentsDomain.get({
      workspaceId: input.workspaceId,
      viewerUserId: input.viewerUserId,
      id: input.id,
    });
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
    return toPublic(doc);
  },
};
