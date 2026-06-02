/**
 * Unit tests for the `ship listen --forward-to <url>` forwarding logic.
 *
 * Strategy: spin up two real local HTTP servers (no mocks needed for the
 * network layer — native fetch + node:http work fine in vitest).
 *
 *  - A "Ship listener" (reusing webhook-listener.ts) that receives signed
 *    deliveries — exactly as the real Ship API would POST to it.
 *  - A "target server" that represents the developer's local app.
 *
 * We drive `verifyAndForward` directly, confirming:
 *   1. Valid signature → target receives the body + expected headers.
 *   2. Tampered/invalid signature → target is NOT reached.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { computeSignature } from '@ship/sdk';
import { startListener, type ReceivedDelivery } from '../webhook-listener.js';
import { verifyAndForward } from '../forwarder.js';

// ---------------------------------------------------------------------------
// Tiny helper: start an HTTP server that records all incoming requests.
// ---------------------------------------------------------------------------
interface ReceivedRequest {
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

interface TargetServer {
  url: string;
  requests: ReceivedRequest[];
  close(): Promise<void>;
}

async function startTargetServer(statusCode = 200): Promise<TargetServer> {
  const requests: ReceivedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      requests.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      res.writeHead(statusCode).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Helpers: build a signed delivery the same way the real Ship API would.
// ---------------------------------------------------------------------------
function makeSignedDelivery(secret: string, body: string): ReceivedDelivery {
  const t = Math.floor(Date.now() / 1000);
  const sig = computeSignature(secret, t, body);
  return {
    rawBody: body,
    headers: {
      'content-type': 'application/json',
      'ship-signature': `t=${t},v1=${sig}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('verifyAndForward — ship listen forwarding logic', () => {
  const secret = 'whsec_listen_unit_test';
  const eventType = 'document.created';
  const payload = JSON.stringify({
    id: 'evt_listen_1',
    type: eventType,
    created: Math.floor(Date.now() / 1000),
    data: { id: 'doc_abc', title: 'Hello world' },
  });

  let target: TargetServer;

  beforeAll(async () => {
    target = await startTargetServer(200);
  });

  afterAll(async () => {
    await target.close();
  });

  it('forwards a valid signed delivery to the target URL', async () => {
    const delivery = makeSignedDelivery(secret, payload);
    const result = await verifyAndForward(delivery, secret, target.url, eventType);

    expect(result.signatureOk).toBe(true);
    expect(result.forwardAttempted).toBe(true);
    expect(result.forwardStatus).toBe(200);
    expect(result.forwardLatencyMs).toBeTypeOf('number');
    expect(result.forwardLatencyMs!).toBeGreaterThanOrEqual(0);

    // Target must have received the request exactly once.
    expect(target.requests).toHaveLength(1);
    const req = target.requests[0]!;

    // Body must be the raw JSON unchanged.
    expect(req.body).toBe(payload);

    // Ship-Signature header must be forwarded.
    expect(req.headers['ship-signature']).toMatch(/^t=\d+,v1=[0-9a-f]+$/);

    // X-Ship-Event header must be set to the event type.
    expect(req.headers['x-ship-event']).toBe(eventType);
  });

  it('does NOT forward a delivery with a tampered body', async () => {
    const requestsBefore = target.requests.length;

    // Build a valid delivery, then mutate the body — signature no longer matches.
    const delivery = makeSignedDelivery(secret, payload);
    const tamperedDelivery: ReceivedDelivery = {
      ...delivery,
      rawBody: delivery.rawBody + ' tampered',
    };

    const result = await verifyAndForward(tamperedDelivery, secret, target.url, eventType);

    expect(result.signatureOk).toBe(false);
    expect(result.forwardAttempted).toBe(false);
    expect(result.forwardStatus).toBeNull();

    // Target must NOT have received any new request.
    expect(target.requests).toHaveLength(requestsBefore);
  });

  it('does NOT forward a delivery with a wrong secret', async () => {
    const requestsBefore = target.requests.length;

    // Delivery signed with the real secret, but we pass the wrong secret to verifyAndForward.
    const delivery = makeSignedDelivery(secret, payload);
    const result = await verifyAndForward(delivery, 'whsec_wrong_secret', target.url, eventType);

    expect(result.signatureOk).toBe(false);
    expect(result.forwardAttempted).toBe(false);
    expect(target.requests).toHaveLength(requestsBefore);
  });

  it('reports forwardAttempted=false when the target is unreachable', async () => {
    const delivery = makeSignedDelivery(secret, payload);
    // Port 1 is reserved and will be refused immediately on most systems.
    const result = await verifyAndForward(delivery, secret, 'http://127.0.0.1:1/', eventType);

    expect(result.signatureOk).toBe(true);
    expect(result.forwardAttempted).toBe(false);
    expect(result.forwardStatus).toBeNull();
  });

  it('reports the HTTP status returned by the target (non-2xx)', async () => {
    // Start a target that always returns 500.
    const errorTarget = await startTargetServer(500);
    try {
      const delivery = makeSignedDelivery(secret, payload);
      const result = await verifyAndForward(delivery, secret, errorTarget.url, eventType);

      expect(result.signatureOk).toBe(true);
      expect(result.forwardAttempted).toBe(true);
      expect(result.forwardStatus).toBe(500);
    } finally {
      await errorTarget.close();
    }
  });
});
