/**
 * Shared, self-contained helpers for the security/protocol drills.
 *
 * Implements the device-approval-over-HTTP pattern: a tiny cookie jar over fetch
 * to log into Ship and approve device codes — using ONLY @ship/sdk + fetch +
 * node builtins (no dependency on any other integration package).
 *
 * The default SHIP_CLIENT_ID is `ship_app_cli` (a public device-flow client
 * seeded by the CLI migration); override via env if your server uses a
 * different public client.
 *
 * Env: SHIP_BASE_URL, SHIP_CLIENT_ID, SHIP_DRILL_EMAIL, SHIP_DRILL_PASSWORD.
 */

export const BASE_URL: string = (process.env['SHIP_BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
export const CLIENT_ID: string = process.env['SHIP_CLIENT_ID'] ?? 'ship_app_cli';
export const EMAIL: string = process.env['SHIP_DRILL_EMAIL'] ?? 'dev@ship.local';
export const PASSWORD: string = process.env['SHIP_DRILL_PASSWORD'] ?? 'admin123';

// ---- tiny cookie jar over fetch ----
const jar = new Map<string, string>();
function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorb(res: Response): void {
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(';');
    const eq = (pair ?? '').indexOf('=');
    if (eq > 0) jar.set((pair ?? '').slice(0, eq), (pair ?? '').slice(eq + 1));
  }
}
export async function jfetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Cookie: cookieHeader() },
    redirect: 'manual',
  });
  absorb(res);
  return res;
}

/** Simulate the human: log into Ship, then approve a device user_code. */
export async function approveDevice(userCode: string): Promise<void> {
  const csrfRes = await jfetch('/api/csrf-token');
  const { token: csrf } = (await csrfRes.json()) as { token: string };
  const login = await jfetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`drill login failed (${login.status}); set SHIP_DRILL_EMAIL/PASSWORD`);
  const page = await jfetch(`/oauth/device?user_code=${encodeURIComponent(userCode)}`);
  const html = await page.text();
  const m = html.match(/name="csrf_token" value="([^"]+)"/);
  if (!m) throw new Error('could not find device consent csrf token');
  const form = new URLSearchParams({ user_code: userCode, decision: 'approve', csrf_token: m[1]! });
  const decision = await jfetch('/oauth/device/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!decision.ok) throw new Error(`device approval failed (${decision.status})`);
}

export function pass(msg: string): void {
  console.log(`\n✓ PASS: ${msg}`);
}

export function fail(msg: string, err?: unknown): never {
  console.error(`\n✗ FAIL: ${msg}`);
  if (err) console.error(err);
  process.exit(1);
}
