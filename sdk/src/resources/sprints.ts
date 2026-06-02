/**
 * sprints resource client. Async-iterator pagination walks pages transparently
 * — the consumer never sees a cursor. Sprints are read-only in the public API.
 */
import type { Http } from '../http.js';
import type { ShipSprint, Page, ListSprintsParams } from '../types.js';

export class SprintsClient {
  constructor(private readonly http: Http) {}

  /** One page of sprints. */
  list(params: ListSprintsParams = {}): Promise<Page<ShipSprint>> {
    return this.http.request<Page<ShipSprint>>('GET', '/sprints', {
      query: {
        limit: params.limit,
        cursor: params.cursor,
        status: params.status,
      },
    });
  }

  get(id: string): Promise<ShipSprint> {
    return this.http.request<ShipSprint>('GET', `/sprints/${encodeURIComponent(id)}`);
  }

  /**
   * Walk every sprint across pages: `for await (const sprint of client.sprints.iterate())`.
   * Cursors are handled internally.
   */
  async *iterate(params: Omit<ListSprintsParams, 'cursor'> = {}): AsyncGenerator<ShipSprint> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...params, cursor });
      for (const sprint of page.data) yield sprint;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }
}
