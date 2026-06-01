/**
 * Concrete WebhooksPort — subscription management + delivery log + replay, over
 * the webhook store and event bus. Lives under platform/adapters; injected into
 * the sealed v1 router by the composition root.
 */
import crypto from 'crypto';
import * as store from '../webhooks/store.js';
import { eventRegistry, type EventType } from '../webhooks/events.js';
import type { InMemoryEventBus } from '../webhooks/event-bus.js';
import type { WebhooksPort, PublicSubscription, PublicDelivery } from '../api/v1/ports.js';

function toPublicSub(r: store.SubscriptionRow): PublicSubscription {
  return { id: r.id, event_type: r.event_type, target_url: r.target_url, active: r.active, created_at: r.created_at };
}
function toPublicDelivery(r: store.DeliveryRow): PublicDelivery {
  return {
    id: r.id, event_type: r.event_type, attempt_number: r.attempt_number, status: r.status,
    response_status: r.response_status, latency_ms: r.latency_ms,
    idempotency_key: r.idempotency_key, created_at: r.created_at,
  };
}

export function createWebhooksAdapter(bus: InMemoryEventBus): WebhooksPort {
  return {
    eventTypes: () => eventRegistry.list(),

    async createSubscription(input) {
      const signing_secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
      const row = await store.createSubscription({
        appId: input.appId,
        eventType: input.eventType as EventType,
        targetUrl: input.targetUrl,
        signingSecret: signing_secret,
      });
      return { subscription: toPublicSub(row), signing_secret };
    },

    async listSubscriptions(appId) {
      return (await store.listSubscriptions(appId)).map(toPublicSub);
    },

    async deactivateSubscription({ appId, id }) {
      const sub = await store.getSubscription(id);
      if (!sub || sub.app_id !== appId) return false;
      await store.deactivateSubscription(id);
      return true;
    },

    async listDeliveries(appId) {
      return (await store.listDeliveries(appId)).map(toPublicDelivery);
    },

    async replay({ appId, deliveryId }) {
      const delivery = await store.getDelivery(deliveryId);
      if (!delivery) return false;
      const sub = await store.getSubscription(delivery.subscription_id);
      if (!sub || sub.app_id !== appId) return false;
      const fresh = await bus.replay(deliveryId);
      return fresh !== null;
    },
  };
}
