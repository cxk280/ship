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

export class WebhooksClient {
  constructor(private readonly http: Http) {}

  /** Subscribe to an event. Returns the subscription + its one-time signing_secret. */
  create(input: { event: string; target_url: string }): Promise<CreatedSubscription> {
    return this.http.request<CreatedSubscription>('POST', '/webhooks', {
      body: { event_type: input.event, target_url: input.target_url },
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
    await this.http.request('POST', `/webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay`, { body: {} });
  }
}
