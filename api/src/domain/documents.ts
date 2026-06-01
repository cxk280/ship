/**
 * Documents domain service — the shared core.
 *
 * Pure data access over the documents table, returning plain domain objects.
 * Both front doors can call this: the public /api/v1 layer (via an injected port
 * + adapter) and, in future, internal routes. It contains no HTTP, no auth, no
 * serialization — just the document operations and keyset pagination.
 */
import { pool } from '../db/client.js';

export interface DomainDocument {
  id: string;
  workspace_id: string;
  document_type: string;
  title: string;
  content: unknown;
  properties: Record<string, unknown>;
  parent_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A decoded keyset cursor position: a document's (created_at, id). */
export interface Keyset {
  createdAt: string;
  id: string;
}

export interface ListResult {
  items: DomainDocument[];
  /** The last item's keyset, present only when another page may follow. */
  nextKeyset: Keyset | null;
}

const COLUMNS =
  'id, workspace_id, document_type::text AS document_type, title, content, properties, parent_id, created_by, created_at, updated_at';

function visibleToViewerSql(workspaceParam: string, viewerParam: string): string {
  return `(visibility = 'workspace' OR created_by = ${viewerParam} OR EXISTS (
      SELECT 1 FROM workspace_memberships
      WHERE workspace_id = ${workspaceParam}
        AND user_id = ${viewerParam}
        AND role = 'admin'
    ))`;
}

export const documentsDomain = {
  /**
   * Keyset pagination ordered by (created_at DESC, id DESC). Stable across
   * inserts/reordering because the cursor encodes an immutable position, not an
   * offset. Returns one extra row internally to decide next-page existence.
   */
  async list(input: {
    workspaceId: string;
    viewerUserId: string | null;
    limit: number;
    after?: Keyset | null;
    documentType?: string;
  }): Promise<ListResult> {
    const params: unknown[] = [input.workspaceId, input.viewerUserId];
    const where = [
      'workspace_id = $1',
      'deleted_at IS NULL',
      visibleToViewerSql('$1', '$2'),
    ];
    if (input.documentType) {
      params.push(input.documentType);
      where.push(`document_type = $${params.length}::document_type`);
    }
    if (input.after) {
      params.push(input.after.createdAt, input.after.id);
      where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(input.limit + 1); // fetch one extra to detect a next page
    const sql = `SELECT ${COLUMNS} FROM documents
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`;
    const r = await pool.query(sql, params);
    const rows = r.rows as DomainDocument[];

    let nextKeyset: Keyset | null = null;
    if (rows.length > input.limit) {
      rows.pop(); // drop the probe row
      const last = rows[rows.length - 1]!;
      nextKeyset = { createdAt: last.created_at, id: last.id };
    }
    return { items: rows, nextKeyset };
  },

  async get(input: {
    workspaceId: string;
    viewerUserId: string | null;
    id: string;
  }): Promise<DomainDocument | null> {
    const r = await pool.query(
      `SELECT ${COLUMNS} FROM documents
       WHERE id = $1
         AND workspace_id = $2
         AND deleted_at IS NULL
         AND ${visibleToViewerSql('$2', '$3')}`,
      [input.id, input.workspaceId, input.viewerUserId],
    );
    return (r.rows[0] as DomainDocument) ?? null;
  },

  async create(input: {
    workspaceId: string;
    createdBy: string | null;
    title: string;
    documentType: string;
    content?: unknown;
    properties?: Record<string, unknown>;
  }): Promise<DomainDocument> {
    const r = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, content, properties, created_by)
       VALUES ($1, $2::document_type, $3, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [
        input.workspaceId,
        input.documentType,
        input.title,
        input.content ?? null,
        JSON.stringify(input.properties ?? {}),
        input.createdBy,
      ],
    );
    return r.rows[0] as DomainDocument;
  },
};
