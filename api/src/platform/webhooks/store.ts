/**
 * Webhook persistence (subscriptions, the event log, the delivery log).
 */
import { pool } from '../../db/client.js';
import type { EventType } from './events.js';

export interface SubscriptionRow {
  id: string;
  app_id: string;
  workspace_id: string | null;
  event_type: string;
  target_url: string;
  signing_secret: string;
  active: boolean;
  created_at: string;
}

export interface DeliveryRow {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  attempt_number: number;
  status: 'pending' | 'delivered' | 'dead';
  response_status: number | null;
  response_excerpt: string | null;
  latency_ms: number | null;
  idempotency_key: string;
  next_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface EventRow {
  id: string;
  event_type: string;
  workspace_id: string | null;
  payload: unknown;
  idempotency_key: string;
  created_at: string;
}

// ---- subscriptions --------------------------------------------------------

export async function createSubscription(input: {
  appId: string;
  workspaceId: string | null;
  eventType: EventType;
  targetUrl: string;
  signingSecret: string;
}): Promise<SubscriptionRow> {
  const r = await pool.query(
    `INSERT INTO webhook_subscriptions (app_id, workspace_id, event_type, target_url, signing_secret)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [input.appId, input.workspaceId, input.eventType, input.targetUrl, input.signingSecret],
  );
  return r.rows[0] as SubscriptionRow;
}

export async function listSubscriptions(appId: string): Promise<SubscriptionRow[]> {
  const r = await pool.query(
    'SELECT * FROM webhook_subscriptions WHERE app_id = $1 ORDER BY created_at DESC',
    [appId],
  );
  return r.rows as SubscriptionRow[];
}

export async function getSubscription(id: string): Promise<SubscriptionRow | null> {
  const r = await pool.query('SELECT * FROM webhook_subscriptions WHERE id = $1', [id]);
  return (r.rows[0] as SubscriptionRow) ?? null;
}

export async function deactivateSubscription(id: string): Promise<void> {
  await pool.query('UPDATE webhook_subscriptions SET active = FALSE, updated_at = now() WHERE id = $1', [id]);
}

/** Active subscriptions whose app is in the event's workspace. */
export async function getMatchingSubscriptions(
  eventType: string,
  workspaceId: string | null,
): Promise<SubscriptionRow[]> {
  // Match on the SUBSCRIPTION's workspace (the workspace of the token that created
  // it), not the app's — so a multi-workspace app (e.g. the CLI) only receives the
  // events of the workspace each subscription was created in.
  const r = await pool.query(
    `SELECT s.* FROM webhook_subscriptions s
     JOIN oauth_apps a ON s.app_id = a.id
     WHERE s.event_type = $1 AND s.active = TRUE AND a.is_active = TRUE
       AND s.workspace_id IS NOT DISTINCT FROM $2`,
    [eventType, workspaceId],
  );
  return r.rows as SubscriptionRow[];
}

// ---- events ---------------------------------------------------------------

export async function insertEvent(input: {
  eventType: EventType;
  workspaceId: string | null;
  payload: unknown;
  idempotencyKey: string;
}): Promise<EventRow> {
  const r = await pool.query(
    `INSERT INTO webhook_events (event_type, workspace_id, payload, idempotency_key)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [input.eventType, input.workspaceId, JSON.stringify(input.payload), input.idempotencyKey],
  );
  return r.rows[0] as EventRow;
}

export async function getEvent(id: string): Promise<EventRow | null> {
  const r = await pool.query('SELECT * FROM webhook_events WHERE id = $1', [id]);
  return (r.rows[0] as EventRow) ?? null;
}

// ---- deliveries -----------------------------------------------------------

export async function insertDelivery(input: {
  subscriptionId: string;
  eventId: string;
  eventType: string;
  idempotencyKey: string;
}): Promise<DeliveryRow> {
  const r = await pool.query(
    `INSERT INTO webhook_deliveries (subscription_id, event_id, event_type, idempotency_key)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [input.subscriptionId, input.eventId, input.eventType, input.idempotencyKey],
  );
  return r.rows[0] as DeliveryRow;
}

export async function updateDeliveryAttempt(
  id: string,
  fields: {
    attemptNumber: number;
    status: 'pending' | 'delivered' | 'dead';
    responseStatus: number | null;
    responseExcerpt: string | null;
    latencyMs: number | null;
    nextAttemptAt: Date | null;
    deliveredAt?: Date | null;
  },
): Promise<void> {
  await pool.query(
    `UPDATE webhook_deliveries
       SET attempt_number = $2, status = $3, response_status = $4, response_excerpt = $5,
           latency_ms = $6, next_attempt_at = $7, delivered_at = COALESCE($8, delivered_at),
           updated_at = now()
     WHERE id = $1`,
    [id, fields.attemptNumber, fields.status, fields.responseStatus,
     fields.responseExcerpt, fields.latencyMs, fields.nextAttemptAt, fields.deliveredAt ?? null],
  );
}

export async function listDeliveries(appId: string, limit = 50): Promise<DeliveryRow[]> {
  const r = await pool.query(
    `SELECT d.* FROM webhook_deliveries d
     JOIN webhook_subscriptions s ON d.subscription_id = s.id
     WHERE s.app_id = $1 ORDER BY d.created_at DESC LIMIT $2`,
    [appId, limit],
  );
  return r.rows as DeliveryRow[];
}

export async function getDelivery(id: string): Promise<DeliveryRow | null> {
  const r = await pool.query('SELECT * FROM webhook_deliveries WHERE id = $1', [id]);
  return (r.rows[0] as DeliveryRow) ?? null;
}
