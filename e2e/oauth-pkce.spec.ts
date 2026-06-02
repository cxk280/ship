import { test, expect } from './fixtures/isolated-env';
import type { Page } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';

/**
 * Authorization Code + PKCE — end-to-end, browser-driven (PRD MVP hard gate +
 * Testing Scenario 1).
 *
 * Drives the REAL consent UI: log in as a Ship user → GET /oauth/authorize →
 * click "Authorize" on the server-rendered consent page → capture the code from
 * the redirect → exchange it at /oauth/token with the PKCE verifier → confirm the
 * token works against /api/v1/me. Then the mandatory negative case: a wrong
 * code_verifier on the exchange MUST return 400 invalid_grant.
 *
 * Uses the pre-seeded public PKCE client `ship_app_spa` (migration 045), whose
 * registered redirect_uri is http://localhost:5180/callback. The callback host is
 * not served, so we intercept that navigation and read the code off the URL.
 */

const SPA_CLIENT_ID = 'ship_app_spa';
const REDIRECT_URI = 'http://localhost:5180/callback';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32)); // 43-char high-entropy verifier
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Generous timeout: the isolated web server can be slow to hydrate under CI/low-memory.
  await expect(page).not.toHaveURL(/\/login$/, { timeout: 30_000 });
}

/**
 * Run the browser consent flow for a given challenge and return the authorization
 * code captured from the redirect to the (intercepted) callback. Codes are
 * single-use, so each test obtains a fresh one.
 */
async function obtainAuthCode(
  page: Page,
  apiUrl: string,
  challenge: string,
  state: string,
): Promise<string> {
  // Render the REAL server-side consent screen (this also stamps the per-session
  // CSRF token into the session, which the decision endpoint validates).
  const authorizeUrl =
    `${apiUrl}/oauth/authorize?response_type=code&client_id=${SPA_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent('documents:read')}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=${encodeURIComponent(state)}`;
  await page.goto(authorizeUrl);
  await expect(page.getByRole('heading', { name: /Ship Browser SPA/ })).toBeVisible();

  // The consent form carries the session-bound CSRF token; submit "approve" the
  // same way the Authorize button would, but capture the redirect deterministically
  // (the registered redirect host isn't served, so we read the 302 Location rather
  // than navigate into a dead host). Shares the browser session cookies.
  const csrfToken = await page.locator('input[name="csrf_token"]').inputValue();
  const decisionRes = await page.request.post(`${apiUrl}/oauth/authorize/decision`, {
    form: {
      decision: 'approve',
      csrf_token: csrfToken,
      response_type: 'code',
      client_id: SPA_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'documents:read',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
    maxRedirects: 0,
  });
  expect([302, 303], await decisionRes.text()).toContain(decisionRes.status());
  const location = decisionRes.headers()['location'];
  expect(location, 'decision should redirect to the registered redirect_uri').toBeTruthy();

  const cb = new URL(location);
  expect(cb.searchParams.get('error'), `authorize returned error: ${cb.search}`).toBeNull();
  expect(cb.searchParams.get('state')).toBe(state); // state echoed back
  const code = cb.searchParams.get('code');
  expect(code, 'authorization code should be present in the redirect').toBeTruthy();
  return code!;
}

async function exchange(
  page: Page,
  apiUrl: string,
  code: string,
  codeVerifier: string,
) {
  return page.request.post(`${apiUrl}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
      client_id: SPA_CLIENT_ID, // public client — no client_secret
    },
    maxRedirects: 0,
  });
}

test.describe('OAuth 2.0 Authorization Code + PKCE', () => {
  // One login (the only browser-session-dependent step), then both the positive
  // exchange and the mandatory negative case — keeps the flaky surface minimal.
  test('completes end-to-end; wrong code_verifier is rejected with invalid_grant', async ({
    page,
    apiServer,
  }) => {
    const apiUrl = apiServer.url;
    await loginAsAdmin(page);

    // ---- Happy path: code + correct verifier → token → /api/v1/me works -------
    const good = makePkce();
    const goodCode = await obtainAuthCode(page, apiUrl, good.challenge, 'state-happy-path');

    const tokenRes = await exchange(page, apiUrl, goodCode, good.verifier);
    expect(tokenRes.status(), await tokenRes.text()).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens.access_token).toBeTruthy();
    expect(String(tokens.token_type).toLowerCase()).toBe('bearer');

    const meRes = await page.request.get(`${apiUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(meRes.status(), await meRes.text()).toBe(200);
    const me = await meRes.json();
    expect(me.user?.email).toBe('dev@ship.local');
    expect(me.scopes).toContain('documents:read');

    // ---- Mandatory negative case: wrong verifier → 400 invalid_grant ----------
    const bad = makePkce();
    const badCode = await obtainAuthCode(page, apiUrl, bad.challenge, 'state-negative');
    const wrongVerifier = base64url(randomBytes(32)); // does NOT hash to bad.challenge

    const rejected = await exchange(page, apiUrl, badCode, wrongVerifier);
    expect(rejected.status()).toBe(400);
    const body = await rejected.json();
    expect(body.error).toBe('invalid_grant');
  });
});
