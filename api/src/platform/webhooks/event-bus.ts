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

/**
 * Resolver that returns the current active Ed25519 private key PEM for an app,
 * or undefined if none is available. Injected so tests can use a no-op stub.
 */
export type Ed25519KeyResolver = (appId: string) => Promise<string | undefined>;

export class InMemoryEventBus implements IEventBus {
  constructor(
    private readonly deps: {
      deliverer: IWebhookDeliverer;
      clock: Clock;
      /** Optional: resolves the active Ed25519 private key for an app. */
      ed25519KeyResolver?: Ed25519KeyResolver;
    },
  ) {}

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
      const ed25519PrivateKeyPem = this.deps.ed25519KeyResolver
        ? await this.deps.ed25519KeyResolver(sub.app_id)
        : undefined;
      this.deps.deliverer.enqueue({
        deliveryId: delivery.id,
        subscription: { id: sub.id, targetUrl: sub.target_url, signingSecret: sub.signing_secret },
        envelope,
        idempotencyKey,
        ed25519PrivateKeyPem,
      });
    }
  }

  /**
   * Send a synthetic test event to a single specific subscription (bypasses
   * the normal fan-out and workspace matching).  The payload is a realistic
   * document.created envelope with `"test": true` so subscribers can identify
   * it.  Returns the new delivery record (status will reflect the actual HTTP
   * response from the target URL).
   */
  async sendTestEvent(subscriptionId: string): Promise<store.DeliveryRow | null> {
    const sub = await store.getSubscription(subscriptionId);
    if (!sub) return null;

    const idempotencyKey = `test_${randomUUID()}`;
    const testPayload = {
      id: '00000000-0000-0000-0000-000000000000',
      document_type: 'wiki',
      title: 'Test Event',
      workspace_id: sub.workspace_id ?? '00000000-0000-0000-0000-000000000000',
      test: true,
    };
    // Persist a synthetic event row so the delivery has a valid FK.
    const eventRow = await store.insertEvent({
      eventType: 'document.created',
      workspaceId: sub.workspace_id,
      payload: testPayload,
      idempotencyKey,
    });
    const envelope: WebhookEnvelope = {
      id: eventRow.id,
      type: 'document.created',
      created: Math.floor(this.deps.clock.now() / 1000),
      data: testPayload,
    };
    const delivery = await store.insertDelivery({
      subscriptionId: sub.id,
      eventId: eventRow.id,
      eventType: 'document.created',
      idempotencyKey,
    });
    this.deps.deliverer.enqueue({
      deliveryId: delivery.id,
      subscription: { id: sub.id, targetUrl: sub.target_url, signingSecret: sub.signing_secret },
      envelope,
      idempotencyKey,
    });
    return delivery;
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
    const ed25519PrivateKeyPem = this.deps.ed25519KeyResolver
      ? await this.deps.ed25519KeyResolver(sub.app_id)
      : undefined;
    this.deps.deliverer.enqueue({
      deliveryId: fresh.id,
      subscription: { id: sub.id, targetUrl: sub.target_url, signingSecret: sub.signing_secret },
      envelope,
      idempotencyKey: old.idempotency_key,
      ed25519PrivateKeyPem,
    });
    return fresh;
  }
}
