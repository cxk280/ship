/**
 * Shared in-memory test doubles for the platform deps (PRD: "in-memory test
 * doubles for every interface"). Not a test file (no `.test.ts`), just helpers.
 */
import type { IEventBus } from '../event-bus.js';
import type { WebhooksPort, PublicSubscription } from '../../api/v1/ports.js';

/** No-op event bus — swallows publishes (delivery is tested separately). */
export const noopBus: IEventBus = {
  async publish() {
    /* no-op */
  },
};

const emptySub: PublicSubscription = {
  id: '00000000-0000-0000-0000-000000000000',
  event_type: 'document.created',
  target_url: 'https://example.com',
  active: true,
  created_at: '1970-01-01T00:00:00.000Z',
};

/** Inert WebhooksPort for tests that don't exercise webhooks. */
export const stubWebhooks: WebhooksPort = {
  eventTypes: () => ['document.created'],
  async createSubscription() {
    return { subscription: emptySub, signing_secret: 'whsec_stub' };
  },
  async listSubscriptions() {
    return [];
  },
  async deactivateSubscription() {
    return true;
  },
  async listDeliveries() {
    return [];
  },
  async replay() {
    return true;
  },
};
