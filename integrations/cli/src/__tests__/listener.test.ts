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

  it('defaults to a local 127.0.0.1 url (drill / local behavior unchanged)', async () => {
    const listener = await startListener();
    expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(listener.url).toBe(listener.localUrl);
    await listener.close();
  });

  it('subscribes with the public tunnel url but still binds locally on a fixed port', async () => {
    // Pick a high fixed port the way a tunnel (`ngrok http <port>`) would target it.
    const port = 8793;
    const listener = await startListener({ port, publicUrl: 'https://ab12.ngrok.app' });
    // The url handed to webhooks.create() is the PUBLIC one (so a remote Ship can reach it),
    // normalized to a single trailing slash...
    expect(listener.url).toBe('https://ab12.ngrok.app/');
    // ...while the server is actually bound to the requested local port.
    expect(listener.localUrl).toBe(`http://127.0.0.1:${port}/`);
    expect(listener.port).toBe(port);

    // A delivery arriving on the local port (as the tunnel would forward it) still verifies.
    const secret = 'whsec_tunnel_test';
    const body = JSON.stringify({ id: 'evt_2', type: 'document.created', created: Math.floor(Date.now() / 1000), data: {} });
    const t = Math.floor(Date.now() / 1000);
    const waiting = listener.waitFor(2000);
    await fetch(listener.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Ship-Signature': `t=${t},v1=${computeSignature(secret, t, body)}` },
      body,
    });
    expect(verifyWebhook((await waiting).headers, body, secret)).toBe(true);
    await listener.close();
  });
});
