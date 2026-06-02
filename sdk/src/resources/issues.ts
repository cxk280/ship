/**
 * issues resource client. Async-iterator pagination walks pages transparently
 * — the consumer never sees a cursor.
 */
import type { Http } from '../http.js';
import type { ShipIssue, Page, ListIssuesParams, CreateIssueInput } from '../types.js';

export interface CreateIssueOptions {
  /**
   * Stripe-grade idempotency: pass a unique client-generated key to guarantee
   * exactly-once semantics. Retrying the same request with the same key returns
   * the original response without creating a duplicate issue.
   */
  idempotencyKey?: string;
}

export class IssuesClient {
  constructor(private readonly http: Http) {}

  /** One page of issues. */
  list(params: ListIssuesParams = {}): Promise<Page<ShipIssue>> {
    return this.http.request<Page<ShipIssue>>('GET', '/issues', {
      query: {
        limit: params.limit,
        cursor: params.cursor,
        state: params.state,
        priority: params.priority,
        assignee_id: params.assignee_id,
      },
    });
  }

  get(id: string): Promise<ShipIssue> {
    return this.http.request<ShipIssue>('GET', `/issues/${encodeURIComponent(id)}`);
  }

  create(input: CreateIssueInput, opts: CreateIssueOptions = {}): Promise<ShipIssue> {
    const headers: Record<string, string> = {};
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    return this.http.request<ShipIssue>('POST', '/issues', { body: input, headers });
  }

  /**
   * Walk every issue across pages: `for await (const issue of client.issues.iterate())`.
   * Cursors are handled internally.
   */
  async *iterate(params: Omit<ListIssuesParams, 'cursor'> = {}): AsyncGenerator<ShipIssue> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...params, cursor });
      for (const issue of page.data) yield issue;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }
}
