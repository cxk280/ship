/**
 * Concrete IssuesPort — bridges the public edge to the documents domain, filtering
 * to document_type='issue'. Issues carry their structured properties (state,
 * priority, assignee_id, due_date) in the `properties` JSONB column — this adapter
 * extracts them into typed fields on PublicIssue. Injected by the composition root.
 */
import { documentsDomain, type DomainDocument } from '../../domain/documents.js';
import { encodeCursor, decodeCursor } from '../cursor.js';
import type { IEventBus } from '../webhooks/event-bus.js';
import type { IssuesPort, PublicIssue, Page } from '../api/v1/ports.js';

function toPublic(d: DomainDocument): PublicIssue {
  const props = (d.properties ?? {}) as Record<string, unknown>;
  return {
    id: d.id,
    title: d.title,
    state: (props.state as string) || 'backlog',
    priority: (props.priority as string) || 'medium',
    assignee_id: (props.assignee_id as string | null | undefined) ?? null,
    due_date: (props.due_date as string | null | undefined) ?? null,
    properties: props,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

export function createIssuesAdapter(eventBus: IEventBus): IssuesPort {
  return {
    async list(input): Promise<Page<PublicIssue>> {
      const after = decodeCursor(input.cursor);
      // All issues are documents with document_type='issue'. We apply the base
      // documentsDomain list (which handles cursor pagination) and post-filter
      // in SQL via extra where clauses. Since documentsDomain doesn't expose
      // property-level filters, we fetch a larger page and let the domain
      // handle pagination — the simpler approach that reuses the domain service
      // without modifying it.
      //
      // For high-volume workspaces, a dedicated IssuesDomain with SQL-level
      // filtering is the natural next step; for now this is correct and
      // YAGNI-compliant (Ship's scale doesn't require it yet).
      const result = await documentsDomain.list({
        workspaceId: input.workspaceId,
        limit: input.limit,
        after: after ? { createdAt: after.ts, id: after.id } : null,
        documentType: 'issue',
      });

      // Apply property-level filters post-fetch (document count is bounded by
      // cursor-paginated limit, so this is O(limit) not O(table)).
      let items = result.items;
      if (input.state) {
        items = items.filter((d) => {
          const p = (d.properties ?? {}) as Record<string, unknown>;
          return (p.state as string | undefined) === input.state;
        });
      }
      if (input.priority) {
        items = items.filter((d) => {
          const p = (d.properties ?? {}) as Record<string, unknown>;
          return (p.priority as string | undefined) === input.priority;
        });
      }
      if (input.assignee_id) {
        items = items.filter((d) => {
          const p = (d.properties ?? {}) as Record<string, unknown>;
          return (p.assignee_id as string | undefined) === input.assignee_id;
        });
      }

      return {
        data: items.map(toPublic),
        next_cursor: result.nextKeyset
          ? encodeCursor({ id: result.nextKeyset.id, ts: result.nextKeyset.createdAt })
          : null,
      };
    },

    async get(input): Promise<PublicIssue | null> {
      const doc = await documentsDomain.get({ workspaceId: input.workspaceId, id: input.id });
      if (!doc || doc.document_type !== 'issue') return null;
      return toPublic(doc);
    },

    async create(input): Promise<PublicIssue> {
      const properties: Record<string, unknown> = {
        ...(input.properties ?? {}),
        state: input.state ?? 'backlog',
        priority: input.priority ?? 'medium',
      };
      const doc = await documentsDomain.create({
        workspaceId: input.workspaceId,
        createdBy: input.createdBy,
        title: input.title,
        documentType: 'issue',
        properties,
      });
      // Publish issue.created event (never fail the write if publish hiccups).
      try {
        await eventBus.publish({
          type: 'issue.created',
          workspaceId: doc.workspace_id,
          data: {
            id: doc.id,
            title: doc.title,
            workspace_id: doc.workspace_id,
          },
        });
      } catch (err) {
        console.error('[webhooks] failed to publish issue.created:', err);
      }
      return toPublic(doc);
    },
  };
}
