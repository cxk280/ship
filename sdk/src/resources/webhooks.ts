/**
 * webhooks resource client. `create()` returns the one-time signing_secret a
 * subscriber stores to verify deliveries with `verifyWebhook`.
 */
import type { Http } from '../http.js';

export interface WebhookSubscription {
  id: string;
  event_type: string;
  target_url: string;
  active: boolean;
  created_at: string;
}

export interface CreatedSubscription extends WebhookSubscription {
  signing_secret: string;
  warning?: string;
}

export interface WebhookDelivery {
  id: string;
  event_type: string;
  attempt_number: number;
  status: string;
  response_status: number | null;
  latency_ms: number | null;
  idempotency_key: string;
  created_at: string;
}

export interface CreateWebhookOptions {
  /**
   * Stripe-grade idempotency: pass a unique client-generated key to guarantee
   * exactly-once semantics. Retrying the same request with the same key returns
   * the original response without creating a duplicate subscription.
   */
  idempotencyKey?: string;
}

export class WebhooksClient {
  constructor(private readonly http: Http) {}

  /** Subscribe to an event. Returns the subscription + its one-time signing_secret. */
  create(input: { event: string; target_url: string }, opts: CreateWebhookOptions = {}): Promise<CreatedSubscription> {
    const headers: Record<string, string> = {};
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    return this.http.request<CreatedSubscription>('POST', '/webhooks', {
      body: { event_type: input.event, target_url: input.target_url },
      headers,
    });
  }

  async list(): Promise<WebhookSubscription[]> {
    const res = await this.http.request<{ data: WebhookSubscription[] }>('GET', '/webhooks');
    return res.data;
  }

  async delete(id: string): Promise<void> {
    await this.http.request('DELETE', `/webhooks/${encodeURIComponent(id)}`);
  }

  async deliveries(): Promise<WebhookDelivery[]> {
    const res = await this.http.request<{ data: WebhookDelivery[] }>('GET', '/webhooks/deliveries');
    return res.data;
  }

  async replay(deliveryId: string): Promise<void> {
    // No request body: the spec declares POST .../replay with no requestBody
    // (the delivery id in the path is the only input). Sending an empty `{}`
    // body would drift from the contract — see the B2 parity oracle.
    await this.http.request('POST', `/webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay`);
  }
}
