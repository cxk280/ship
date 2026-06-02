/**
 * documents resource client. Async-iterator pagination walks pages transparently
 * — the consumer never sees a cursor.
 */
import type { Http } from '../http.js';
import type { ShipDocument, Page, ListDocumentsParams, CreateDocumentInput } from '../types.js';

export interface CreateDocumentOptions {
  /**
   * Stripe-grade idempotency: pass a unique client-generated key to guarantee
   * exactly-once semantics. Retrying the same request with the same key returns
   * the original response without creating a duplicate document.
   */
  idempotencyKey?: string;
}

export class DocumentsClient {
  constructor(private readonly http: Http) {}

  /** One page of documents. */
  list(params: ListDocumentsParams = {}): Promise<Page<ShipDocument>> {
    return this.http.request<Page<ShipDocument>>('GET', '/documents', {
      query: { limit: params.limit, cursor: params.cursor, document_type: params.document_type },
    });
  }

  get(id: string): Promise<ShipDocument> {
    return this.http.request<ShipDocument>('GET', `/documents/${encodeURIComponent(id)}`);
  }

  create(input: CreateDocumentInput, opts: CreateDocumentOptions = {}): Promise<ShipDocument> {
    const headers: Record<string, string> = {};
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    return this.http.request<ShipDocument>('POST', '/documents', { body: input, headers });
  }

  /**
   * Walk every document across pages: `for await (const doc of client.documents.iterate())`.
   * Cursors are handled internally.
   */
  async *iterate(params: Omit<ListDocumentsParams, 'cursor'> = {}): AsyncGenerator<ShipDocument> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...params, cursor });
      for (const doc of page.data) yield doc;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }
}
