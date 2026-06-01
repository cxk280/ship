/** Public DTOs mirroring the Ship API (kept parity-tested against the OpenAPI spec). */

export interface ShipUser {
  id: string;
  email: string;
  name: string;
}

export interface MeResponse {
  user: ShipUser | null;
  app: { client_id: string };
  scopes: string[];
  workspace_id: string | null;
}

export interface ShipDocument {
  id: string;
  document_type: string;
  title: string;
  content?: unknown;
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

export interface ListDocumentsParams {
  limit?: number;
  cursor?: string;
  document_type?: 'wiki' | 'issue' | 'program' | 'project' | 'sprint' | 'person';
}

export interface CreateDocumentInput {
  title?: string;
  document_type?: 'wiki' | 'issue' | 'program' | 'project' | 'sprint' | 'person';
  content?: unknown;
  properties?: Record<string, unknown>;
}
