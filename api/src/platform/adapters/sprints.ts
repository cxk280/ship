/**
 * Concrete SprintsPort — bridges the public edge to the documents domain, filtering
 * to document_type='sprint'. Sprints carry their structured properties (sprint_number,
 * start_date, end_date, status) in the `properties` JSONB column. This adapter is
 * read-only (list + get) because sprint lifecycle involves complex approval workflows
 * (owner, supervisor, accountability) that are risky to expose without careful
 * domain modeling. Injected by the composition root.
 */
import { documentsDomain, type DomainDocument } from '../../domain/documents.js';
import { encodeCursor, decodeCursor } from '../cursor.js';
import type { SprintsPort, PublicSprint, Page } from '../api/v1/ports.js';

/** Derive a sprint's logical status from its properties. */
function deriveStatus(props: Record<string, unknown>): string {
  // Sprint status may be stored explicitly or inferred from date fields.
  if (props.status) return props.status as string;
  if (props.completed_at || props.end_date) {
    // If end_date is in the past, treat as completed.
    const endDate = props.completed_at ?? props.end_date;
    if (typeof endDate === 'string' && new Date(endDate) < new Date()) return 'completed';
  }
  if (props.start_date && typeof props.start_date === 'string') {
    if (new Date(props.start_date) <= new Date()) return 'active';
  }
  return 'planned';
}

function toPublic(d: DomainDocument): PublicSprint {
  const props = (d.properties ?? {}) as Record<string, unknown>;
  const sprintNum = props.sprint_number;
  return {
    id: d.id,
    title: d.title,
    status: deriveStatus(props),
    sprint_number: typeof sprintNum === 'number' ? sprintNum : null,
    start_date: (props.start_date as string | null | undefined) ?? null,
    end_date: (props.end_date as string | null | undefined) ?? null,
    properties: props,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

export function createSprintsAdapter(): SprintsPort {
  return {
    async list(input): Promise<Page<PublicSprint>> {
      const after = decodeCursor(input.cursor);
      const result = await documentsDomain.list({
        workspaceId: input.workspaceId,
        limit: input.limit,
        after: after ? { createdAt: after.ts, id: after.id } : null,
        documentType: 'sprint',
      });

      // Apply status filter post-fetch (bounded by cursor limit, O(limit)).
      let items = result.items;
      if (input.status) {
        items = items.filter((d) => {
          const props = (d.properties ?? {}) as Record<string, unknown>;
          return deriveStatus(props) === input.status;
        });
      }

      return {
        data: items.map(toPublic),
        next_cursor: result.nextKeyset
          ? encodeCursor({ id: result.nextKeyset.id, ts: result.nextKeyset.createdAt })
          : null,
      };
    },

    async get(input): Promise<PublicSprint | null> {
      const doc = await documentsDomain.get({ workspaceId: input.workspaceId, id: input.id });
      if (!doc || doc.document_type !== 'sprint') return null;
      return toPublic(doc);
    },
  };
}
