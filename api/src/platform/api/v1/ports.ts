/**
 * Domain ports for the public edge (DIP).
 *
 * The sealed v1 layer depends only on these INTERFACES. Concrete adapters (which
 * touch the database / internal services) live under platform/adapters and are
 * wired into the router by the composition root. This is what keeps
 * platform/api/v1/** free of any api/src import — and what the boundary lint
 * enforces.
 */

/** Minimal authenticated-user view returned by /api/v1/me. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
}

/** Identity lookups the public edge needs. */
export interface IdentityPort {
  getUser(userId: string): Promise<PublicUser | null>;
}

/** Public representation of a document on the v1 API. */
export interface PublicDocument {
  id: string;
  document_type: string;
  title: string;
  content: unknown;
  properties: Record<string, unknown>;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A page of results with an opaque cursor to the next page (null at the end). */
export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/** Documents operations the public edge needs (DIP — implemented by an adapter). */
export interface DocumentsPort {
  list(input: {
    workspaceId: string;
    limit: number;
    cursor?: string;
    documentType?: string;
  }): Promise<Page<PublicDocument>>;

  get(input: { workspaceId: string; id: string }): Promise<PublicDocument | null>;

  create(input: {
    workspaceId: string;
    createdBy: string | null;
    title: string;
    documentType: string;
    content?: unknown;
    properties?: Record<string, unknown>;
  }): Promise<PublicDocument>;
}
