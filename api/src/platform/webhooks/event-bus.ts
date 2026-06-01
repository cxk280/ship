/**
 * IEventBus — the domain publishes typed events on writes; the bus records the
 * event, matches subscriptions, and hands each a delivery to the deliverer.
 *
 * In-process implementation is must-ship; a queue-backed bus is a Liskov drop-in.
 */
import { randomUUID } from 'crypto';
import { eventRegistry, type EventType, type WebhookEnvelope } from './events.js';
import type { IWebhookDeliverer } from './deliverer.js';
import * as store from './store.js';
import type { Clock } from './clock.js';

export interface DomainEvent {
  type: EventType;
  workspaceId: string | null;
  data: Record<string, unknown>;
}

export interface IEventBus {
  publish(event: DomainEvent): Promise<void>;
}

export class InMemoryEventBus implements IEventBus {
  constructor(private readonly deps: { deliverer: IWebhookDeliverer; clock: Clock }) {}

  async publish(event: DomainEvent): Promise<void> {
    // Validate against the event's registered schema (closed, typed set).
    eventRegistry.validate(event.type, event.data);

    const idempotencyKey = randomUUID();
    const row = await store.insertEvent({
      eventType: event.type,
      workspaceId: event.workspaceId,
      payload: event.data,
      idempotencyKey,
    });

    const subs = await store.getMatchingSubscriptions(event.type, event.workspaceId);
    const envelope: WebhookEnvelope = {
      id: row.id,
      type: event.type,
      created: Math.floor(this.deps.clock.now() / 1000),
      data: event.data,
    };

    for (const sub of subs) {
      const delivery = await store.insertDelivery({
        subscriptionId: sub.id,
        eventId: row.id,
        eventType: event.type,
        idempotencyKey,
      });
      this.deps.deliverer.enqueue({
        deliveryId: delivery.id,
        subscription: { id: sub.id, targetUrl: sub.target_url, signingSecret: sub.signing_secret },
        envelope,
        idempotencyKey,
      });
    }
  }

  /**
   * Replay a logged delivery: create a NEW delivery for the same subscription
   * carrying the ORIGINAL idempotency key (so subscribers can dedupe).
   */
  async replay(deliveryId: string): Promise<store.DeliveryRow | null> {
    const old = await store.getDelivery(deliveryId);
    if (!old) return null;
    const sub = await store.getSubscription(old.subscription_id);
    const event = await store.getEvent(old.event_id);
    if (!sub || !event) return null;

    const fresh = await store.insertDelivery({
      subscriptionId: sub.id,
      eventId: event.id,
      eventType: event.event_type,
      idempotencyKey: old.idempotency_key, // original key preserved
    });
    const envelope: WebhookEnvelope = {
      id: event.id,
      type: event.event_type as EventType,
      created: Math.floor(this.deps.clock.now() / 1000),
      data: event.payload as Record<string, unknown>,
    };
    this.deps.deliverer.enqueue({
      deliveryId: fresh.id,
      subscription: { id: sub.id, targetUrl: sub.target_url, signingSecret: sub.signing_secret },
      envelope,
      idempotencyKey: old.idempotency_key,
    });
    return fresh;
  }
}
