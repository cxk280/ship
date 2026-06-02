/**
 * Typed discriminated union for all known Ship webhook event types, plus a
 * `parseWebhookEvent` helper that validates the raw JSON body and narrows it.
 *
 * Event shape mirrors the API's webhook delivery payload:
 *   { event: "<resource>.<action>", data: { ... } }
 *
 * If the event type is unrecognized the helper returns an `UnknownWebhookEvent`
 * variant with `kind: "unknown"` rather than throwing — consumers can handle or
 * ignore unknown events gracefully as the API evolves.
 */

import type { ShipDocument, ShipIssue, ShipSprint } from '../types.js';

// ---- Per-event data shapes --------------------------------------------------

export interface DocumentCreatedData {
  document: ShipDocument;
}

export interface DocumentUpdatedData {
  document: ShipDocument;
  /** Field names that changed. */
  changed_fields?: string[];
}

export interface DocumentDeletedData {
  document_id: string;
  document_type: string;
}

export interface IssueCreatedData {
  issue: ShipIssue;
}

export interface IssueAssignedData {
  issue: ShipIssue;
  previous_assignee_id: string | null;
}

export interface IssueStatusChangedData {
  issue: ShipIssue;
  previous_state: string;
}

export interface SprintStartedData {
  sprint: ShipSprint;
}

export interface SprintCompletedData {
  sprint: ShipSprint;
  /** Number of issues moved to the next sprint, if any. */
  issues_carried_over?: number;
}

// ---- Discriminated union ----------------------------------------------------

export type ShipWebhookEvent =
  | { type: 'document.created'; data: DocumentCreatedData }
  | { type: 'document.updated'; data: DocumentUpdatedData }
  | { type: 'document.deleted'; data: DocumentDeletedData }
  | { type: 'issue.created'; data: IssueCreatedData }
  | { type: 'issue.assigned'; data: IssueAssignedData }
  | { type: 'issue.status_changed'; data: IssueStatusChangedData }
  | { type: 'sprint.started'; data: SprintStartedData }
  | { type: 'sprint.completed'; data: SprintCompletedData }
  | { type: 'unknown'; rawType: string; data: unknown };

/** All known event type strings. Useful for filtering subscriptions. */
export const KNOWN_EVENT_TYPES = [
  'document.created',
  'document.updated',
  'document.deleted',
  'issue.created',
  'issue.assigned',
  'issue.status_changed',
  'sprint.started',
  'sprint.completed',
] as const;

export type KnownWebhookEventType = (typeof KNOWN_EVENT_TYPES)[number];

// ---- Parser -----------------------------------------------------------------

/**
 * Parse and narrow a raw webhook event body.
 *
 * Pass the **raw** request body string (the same string you pass to
 * `verifyWebhook`). The body must be valid JSON with at least `{ type, data }`.
 *
 * Throws a `TypeError` if the body is not valid JSON or is missing required
 * fields, so the caller can respond 400 immediately.
 *
 * Returns an `UnknownWebhookEvent` (kind: "unknown") for unrecognized types
 * rather than throwing — this keeps handlers forward-compatible.
 */
export function parseWebhookEvent(rawBody: string): ShipWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new TypeError('parseWebhookEvent: body is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError('parseWebhookEvent: body must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['type'] !== 'string') {
    throw new TypeError('parseWebhookEvent: missing required field "type"');
  }
  if (!('data' in obj)) {
    throw new TypeError('parseWebhookEvent: missing required field "data"');
  }

  const type = obj['type'] as string;
  const data = obj['data'];

  switch (type) {
    case 'document.created':
      return { type, data: data as DocumentCreatedData };
    case 'document.updated':
      return { type, data: data as DocumentUpdatedData };
    case 'document.deleted':
      return { type, data: data as DocumentDeletedData };
    case 'issue.created':
      return { type, data: data as IssueCreatedData };
    case 'issue.assigned':
      return { type, data: data as IssueAssignedData };
    case 'issue.status_changed':
      return { type, data: data as IssueStatusChangedData };
    case 'sprint.started':
      return { type, data: data as SprintStartedData };
    case 'sprint.completed':
      return { type, data: data as SprintCompletedData };
    default:
      return { type: 'unknown', rawType: type, data };
  }
}
