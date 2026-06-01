/**
 * Event registry — event types are DATA (like scopes). Each has a Zod schema for
 * its payload, so the events a webhook can carry are a closed, validated set.
 * The domain layer publishes these on writes (never the route layer).
 */
import { z } from 'zod';

export const EVENT_TYPES = [
  'document.created',
  'document.updated',
  'document.deleted',
  'issue.created',
  'issue.assigned',
  'issue.status_changed',
  'sprint.started',
  'sprint.completed',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// ---- payload schemas ------------------------------------------------------

const DocumentData = z.object({
  id: z.string().uuid(),
  document_type: z.string(),
  title: z.string(),
  workspace_id: z.string().uuid(),
});
const IssueAssignedData = DocumentData.extend({ assignee_id: z.string().uuid().nullable() });
const IssueStatusData = DocumentData.extend({ state: z.string() });
const SprintData = z.object({
  id: z.string().uuid(),
  title: z.string(),
  workspace_id: z.string().uuid(),
});

const SCHEMA_BY_TYPE: Record<EventType, z.ZodTypeAny> = {
  'document.created': DocumentData,
  'document.updated': DocumentData,
  'document.deleted': DocumentData,
  'issue.created': DocumentData,
  'issue.assigned': IssueAssignedData,
  'issue.status_changed': IssueStatusData,
  'sprint.started': SprintData,
  'sprint.completed': SprintData,
};

export interface EventDef {
  type: EventType;
  schema: z.ZodTypeAny;
}

class EventRegistry {
  private readonly events = new Map<EventType, EventDef>();
  constructor() {
    for (const type of EVENT_TYPES) {
      this.events.set(type, { type, schema: SCHEMA_BY_TYPE[type] });
    }
  }
  has(type: string): type is EventType {
    return this.events.has(type as EventType);
  }
  get(type: EventType): EventDef | undefined {
    return this.events.get(type);
  }
  list(): EventType[] {
    return [...EVENT_TYPES];
  }
  /** Validate a payload against its event's schema (throws ZodError on mismatch). */
  validate(type: EventType, payload: unknown): unknown {
    return this.events.get(type)!.schema.parse(payload);
  }
}

export const eventRegistry = new EventRegistry();

/** The envelope POSTed to subscribers (and the body the SDK verifies + parses). */
export interface WebhookEnvelope {
  id: string; // webhook_events.id
  type: EventType;
  created: number; // unix seconds
  data: unknown;
}
