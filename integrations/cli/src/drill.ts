/**
 * Time-to-First-Event (TTFE) drill — the signature challenge.
 *
 * Runs the five-line story end-to-end against a running Ship instance and times
 * each stage: device login → subscribe → create document → receive signed webhook
 * → verify. Total must be < 60s (CI) / ≤ 30 min (clean machine).
 *
 *   pnpm --filter @ship/cli drill ttfe
 *
 * The device-grant "human approval" is automated here over HTTP (login + approve),
 * using only @ship/sdk + fetch — integrations import nothing from api/src.
 *
 * Env: SHIP_BASE_URL, SHIP_CLIENT_ID (default ship_app_cli),
 *      SHIP_DRILL_EMAIL + SHIP_DRILL_PASSWORD (a seeded Ship user to approve as).
 */
import { ShipClient, verifyWebhook } from '@ship/sdk';
import { BASE_URL, CLIENT_ID, SCOPES } from './config.js';
import { startListener } from './webhook-listener.js';

const EMAIL = process.env.SHIP_DRILL_EMAIL ?? 'dev@ship.local';
const PASSWORD = process.env.SHIP_DRILL_PASSWORD ?? 'admin123';

// ---- a tiny cookie jar over fetch -----------------------------------------
const jar = new Map<string, string>();
function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorb(res: Response): void {
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(';');
    const eq = pair!.indexOf('=');
    if (eq > 0) jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
  }
}
async function jfetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Cookie: cookieHeader() },
    redirect: 'manual',
  });
  absorb(res);
  return res;
}

/** Simulate the human: log into Ship, then approve the device user_code. */
async function approveDevice(userCode: string): Promise<void> {
  // 1) CSRF token (also seeds the csrf session cookie).
  const csrfRes = await jfetch('/api/csrf-token');
  const { token: csrf } = (await csrfRes.json()) as { token: string };
  // 2) Log in (session cookie).
  const login = await jfetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`drill login failed (${login.status}); set SHIP_DRILL_EMAIL/PASSWORD`);
  // 3) Render the device consent page to mint its CSRF token.
  const page = await jfetch(`/oauth/device?user_code=${encodeURIComponent(userCode)}`);
  const html = await page.text();
  const m = html.match(/name="csrf_token" value="([^"]+)"/);
  if (!m) throw new Error('could not find device consent csrf token');
  // 4) Approve.
  const form = new URLSearchParams({ user_code: userCode, decision: 'approve', csrf_token: m[1]! });
  const decision = await jfetch('/oauth/device/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!decision.ok) throw new Error(`device approval failed (${decision.status})`);
}

function ms(from: number): number {
  return Math.round(performance.now() - from);
}

async function drill(): Promise<void> {
  const stages: Record<string, number> = {};
  const t0 = performance.now();
  const listener = await startListener();

  // 1) Device login (auto-approve in parallel once the user_code is shown).
  const tLogin = performance.now();
  const client = await ShipClient.deviceLogin({
    origin: BASE_URL,
    clientId: CLIENT_ID,
    scope: SCOPES,
    pollIntervalMs: 1000,
    onUserCode: (code) => {
      approveDevice(code).catch((e) => console.error('auto-approve error:', e));
    },
  });
  stages.login = ms(tLogin);

  // 2) Subscribe to document.created.
  const tSub = performance.now();
  const sub = await client.webhooks.create({ event: 'document.created', target_url: listener.url });
  stages.subscribe = ms(tSub);

  // 3) Trigger: create a document.
  const tCreate = performance.now();
  const doc = await client.documents.create({ title: 'hello' });
  stages.create = ms(tCreate);

  // 4) Receive the signed delivery.
  const tRecv = performance.now();
  const delivery = await listener.waitFor(5000);
  stages.receive = ms(tRecv);

  // 5) Verify the signature.
  const tVerify = performance.now();
  const verified = verifyWebhook(delivery.headers, delivery.rawBody, sub.signing_secret);
  stages.verify = ms(tVerify);

  const total = ms(t0);
  await listener.close();

  const envelope = JSON.parse(delivery.rawBody) as { type?: string; data?: { id?: string } };
  console.log('\n  TTFE drill — five-line story');
  console.log(`  login     ${String(stages.login).padStart(6)} ms`);
  console.log(`  subscribe ${String(stages.subscribe).padStart(6)} ms`);
  console.log(`  create    ${String(stages.create).padStart(6)} ms`);
  console.log(`  receive   ${String(stages.receive).padStart(6)} ms`);
  console.log(`  verify    ${String(stages.verify).padStart(6)} ms`);
  console.log(`  ─────────────────────`);
  console.log(`  total     ${String(total).padStart(6)} ms`);
  console.log(`\n  → ${envelope.type} for ${doc.id}  ${verified ? 'signature verified ✓' : 'INVALID ✗'}`);

  if (!verified) throw new Error('signature did not verify');
  if (envelope.type !== 'document.created') throw new Error(`unexpected event: ${envelope.type}`);
  if (envelope.data?.id !== doc.id) throw new Error('event id did not match the created document');
  if (total >= 60_000) throw new Error(`TTFE ${total}ms exceeded the 60s budget`);
  console.log('\n✓ TTFE drill passed.');
}

drill().catch((err) => {
  console.error(`\n✗ TTFE drill failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
