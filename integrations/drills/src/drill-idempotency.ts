/**
 * Idempotency-key drill.
 *
 * Proves that replaying a webhook delivery (via
 * POST /api/v1/webhooks/deliveries/:id/replay) sends the SAME Idempotency-Key
 * header so a subscriber can detect and deduplicate the replay without
 * double-processing.
 *
 * Steps:
 *   1. Device-login (obtain an access token via @ship/sdk runDeviceLogin).
 *   2. Start a local webhook listener.
 *   3. Subscribe to document.created (POST /api/v1/webhooks).
 *   4. Create a document → capture the first delivery's Idempotency-Key.
 *   5. Find the delivery id (GET /api/v1/webhooks/deliveries) and replay it
 *      (POST /api/v1/webhooks/deliveries/:id/replay).
 *   6. Capture the replayed delivery's Idempotency-Key.
 *   7. Assert both keys are identical.
 *
 * Uses ONLY @ship/sdk (runDeviceLogin + verifyWebhook) + fetch + node builtins.
 * The webhook REST endpoints are called directly because the SDK's typed
 * webhooks client is not part of this branch's SDK.
 *
 * Env: SHIP_BASE_URL, SHIP_CLIENT_ID, SHIP_DRILL_EMAIL, SHIP_DRILL_PASSWORD.
 *
 *   pnpm --filter @ship/drills drill:idempotency
 */
import http from 'node:http';
import { runDeviceLogin, verifyWebhook } from '@ship/sdk';
import { BASE_URL, CLIENT_ID, approveDevice, pass, fail } from './helpers.js';

interface Delivery {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

interface Listener {
  url: string;
  waitFor(ms: number): Promise<Delivery>;
  close(): Promise<void>;
}

function startListener(): Promise<Listener> {
  const waiters: ((d: Delivery) => void)[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const d: Delivery = {
        headers: req.headers as Record<string, string | string[] | undefined>,
        rawBody: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(200).end('ok');
      while (waiters.length) waiters.shift()!(d);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        waitFor: (ms) =>
          new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('timed out waiting for delivery')), ms);
            waiters.push((d) => { clearTimeout(t); res(d); });
          }),
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

interface WebhookDelivery {
  id: string;
  event_type: string;
  idempotency_key: string;
  created_at: string;
}

async function drill(): Promise<void> {
  console.log('Idempotency-key drill — replay dedup proof\n');

  // Step 1: Device login → access token.
  console.log('  [1] Device login…');
  const { tokenStore } = await runDeviceLogin({
    origin: BASE_URL,
    clientId: CLIENT_ID,
    scope: 'documents:read documents:write webhooks:manage',
    pollIntervalMs: 1000,
    onUserCode: (code) => {
      console.log(`      user_code: ${code} — auto-approving…`);
      approveDevice(code).catch((e) => console.error('auto-approve error:', e));
    },
  });
  const stored = await tokenStore.get();
  const accessToken = stored?.access_token;
  if (!accessToken) fail('No access token after device login');
  console.log('  [1] Logged in.');

  // Authenticated REST helper against /api/v1.
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE_URL}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  // Step 2: Start listener.
  const listener = await startListener();
  console.log(`  [2] Listener started at ${listener.url}`);

  // Step 3: Subscribe.
  const sub = await api<{ id: string; signing_secret: string }>('POST', '/webhooks', {
    event_type: 'document.created',
    target_url: listener.url,
  });
  console.log(`  [3] Subscribed to document.created (id=${sub.id})`);

  // Step 4: Create document → first delivery.
  console.log('  [4] Creating document…');
  const doc = await api<{ id: string }>('POST', '/documents', { title: 'idempotency-test' });
  console.log(`  [4] Document created (id=${doc.id}). Waiting for first delivery…`);
  const first = await listener.waitFor(8000);

  // Verify signature of first delivery.
  if (!verifyWebhook(first.headers, first.rawBody, sub.signing_secret)) {
    fail('First delivery signature did not verify');
  }

  const firstIdempotencyKey = headerValue(first.headers, 'idempotency-key');
  if (!firstIdempotencyKey) fail('First delivery missing Idempotency-Key header');
  console.log(`  [4] First delivery received. Idempotency-Key: ${firstIdempotencyKey}`);

  // Step 5: Find the delivery id from the server's delivery log, then replay.
  const { data: deliveries } = await api<{ data: WebhookDelivery[] }>('GET', '/webhooks/deliveries');
  const delivery = deliveries.find((d) => d.idempotency_key === firstIdempotencyKey);
  if (!delivery) fail('Could not find the delivery in the server log');
  console.log(`  [4] Matched delivery id: ${delivery!.id}`);

  console.log('\n  [5] Replaying delivery…');
  const waitingReplay = listener.waitFor(8000);
  await api('POST', `/webhooks/deliveries/${encodeURIComponent(delivery!.id)}/replay`, {});

  // Step 6: Capture replayed delivery.
  const replayed = await waitingReplay;
  const replayIdempotencyKey = headerValue(replayed.headers, 'idempotency-key');
  if (!replayIdempotencyKey) fail('Replayed delivery missing Idempotency-Key header');
  console.log(`  [6] Replayed delivery received. Idempotency-Key: ${replayIdempotencyKey}`);

  // Step 7: Assert same key.
  if (firstIdempotencyKey !== replayIdempotencyKey) {
    fail(
      `Idempotency-Key mismatch!\n  original: ${firstIdempotencyKey}\n  replay:   ${replayIdempotencyKey}`,
    );
  }

  await listener.close();
  pass(
    `Idempotency-key drill: original and replay share the same key (${firstIdempotencyKey}) — subscribers can safely deduplicate.`,
  );
}

drill().catch((err) => {
  console.error(`\n✗ Drill failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
