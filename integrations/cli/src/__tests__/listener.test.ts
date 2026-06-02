/**
 * The local webhook listener captures the raw body so a signed delivery verifies
 * with the SDK helper — the core of `ship webhooks tail` and the TTFE drill.
 */
import { describe, it, expect } from 'vitest';
import { computeSignature, verifyWebhook } from '@ship/sdk';
import { startListener } from '../webhook-listener.js';

describe('webhook listener + verify', () => {
  it('receives a POST and verifies its HMAC signature', async () => {
    const listener = await startListener();
    const secret = 'whsec_cli_test';
    const body = JSON.stringify({ id: 'evt_1', type: 'document.created', created: Math.floor(Date.now() / 1000), data: {} });
    const t = Math.floor(Date.now() / 1000);
    const sig = computeSignature(secret, t, body);

    const waiting = listener.waitFor(2000);
    await fetch(listener.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Ship-Signature': `t=${t},v1=${sig}` },
      body,
    });
    const delivery = await waiting;
    expect(verifyWebhook(delivery.headers, delivery.rawBody, secret)).toBe(true);
    expect(verifyWebhook(delivery.headers, delivery.rawBody + 'x', secret)).toBe(false);
    await listener.close();
  });
});
