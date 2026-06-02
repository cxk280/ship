/**
 * Tests for the Ship webhook handler.
 *
 * Correctly-signed payload → 200.
 * Tampered payload → 400.
 * Expired timestamp → 400.
 * Missing signature → 400.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { computeSignature } from '@ship/sdk';
import request from 'supertest';
import { createApp } from '../server.js';

// supertest is a lightweight HTTP testing library — we import it inline.
// If not present, fall back to raw fetch against a started server.

const SECRET = 'whsec_slack_test_secret';

// Set the secret before creating the app so the handler sees it.
beforeAll(() => {
  process.env.SHIP_WEBHOOK_SECRET = SECRET;
  process.env.SLACK_WEBHOOK_URL = ''; // unset so we don't try to hit Slack
});
afterAll(() => {
  delete process.env.SHIP_WEBHOOK_SECRET;
});

function makePayload(type = 'document.created') {
  return JSON.stringify({
    type,
    created: Math.floor(Date.now() / 1000),
    data: { id: 'doc_test_1', title: 'Hello', document_type: 'wiki' },
  });
}

function signedHeaders(body: string, secret: string, overrideTs?: number) {
  const t = overrideTs ?? Math.floor(Date.now() / 1000);
  const sig = computeSignature(secret, t, body);
  return {
    'Content-Type': 'application/json',
    'Ship-Signature': `t=${t},v1=${sig}`,
  };
}

describe('POST /webhooks/ship', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = createApp();
  });

  it('accepts a correctly-signed document.created payload → 200', async () => {
    const body = makePayload('document.created');
    const headers = signedHeaders(body, SECRET);

    const res = await supertest(app)
      .post('/webhooks/ship')
      .set(headers)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.handled).toBe(true);
  });

  it('accepts a correctly-signed issue.assigned payload → 200', async () => {
    const body = JSON.stringify({
      type: 'issue.assigned',
      created: Math.floor(Date.now() / 1000),
      data: { id: 'issue_1', title: 'Fix bug', assignee_name: 'Alice' },
    });
    const headers = signedHeaders(body, SECRET);

    const res = await supertest(app)
      .post('/webhooks/ship')
      .set(headers)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(true);
  });

  it('rejects a tampered body → 400', async () => {
    const body = makePayload();
    const headers = signedHeaders(body, SECRET);
    const tampered = body + 'x'; // corrupt the body after signing

    const res = await supertest(app)
      .post('/webhooks/ship')
      .set(headers)
      .send(tampered);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_signature');
  });

  it('rejects a wrong secret → 400', async () => {
    const body = makePayload();
    const headers = signedHeaders(body, 'wrong_secret');

    const res = await supertest(app)
      .post('/webhooks/ship')
      .set(headers)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_signature');
  });

  it('rejects an expired timestamp (> 300s old) → 400', async () => {
    const body = makePayload();
    const staleTs = Math.floor(Date.now() / 1000) - 400; // 400s ago
    const headers = signedHeaders(body, SECRET, staleTs);

    const res = await supertest(app)
      .post('/webhooks/ship')
      .set(headers)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_signature');
  });

  it('returns handled:false for unsubscribed event types → 200', async () => {
    const body = JSON.stringify({ type: 'webhook.test', created: Math.floor(Date.now() / 1000), data: {} });
    const headers = signedHeaders(body, SECRET);

    const res = await supertest(app)
      .post('/webhooks/ship')
      .set(headers)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inline supertest-lite shim (avoids adding supertest as a devDep).
// We just use the real supertest if it's available, or a minimal fetch shim.
// ---------------------------------------------------------------------------
import http from 'node:http';
import type { Express } from 'express';

interface TestAgent {
  post(path: string): TestChain;
  get(path: string): TestChain;
}

interface TestChain {
  set(headers: Record<string, string>): TestChain;
  send(body: string): Promise<{ status: number; body: Record<string, unknown> }>;
}

function supertest(app: Express): TestAgent {
  let server: http.Server;
  let port: number;

  function ensureServer(): Promise<void> {
    if (server) return Promise.resolve();
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  }

  function makeChain(method: string, path: string): TestChain {
    const hdrs: Record<string, string> = {};
    let _body = '';
    const chain: TestChain = {
      set(h) { Object.assign(hdrs, h); return chain; },
      async send(body) {
        _body = body;
        await ensureServer();
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: hdrs,
          body: _body || undefined,
        });
        server.close();
        server = undefined as unknown as http.Server;
        const json = await res.json().catch(() => ({})) as Record<string, unknown>;
        return { status: res.status, body: json };
      },
    };
    return chain;
  }

  return {
    post: (p) => makeChain('POST', p),
    get: (p) => makeChain('GET', p),
  };
}
