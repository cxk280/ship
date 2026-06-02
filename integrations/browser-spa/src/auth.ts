/**
 * Authorization Code + PKCE flow for the browser SPA.
 *
 * Storage: sessionStorage is used for the PKCE verifier and state nonce so
 * they survive the redirect but are scoped to the tab and cleared on close.
 * The access token is stored in-memory only (no localStorage — XSS safety).
 */
import { generatePkce } from './pkce.js';
import { BASE_URL, CLIENT_ID, REDIRECT_URI, SCOPES } from './config.js';

const STORAGE_VERIFIER = 'ship_pkce_verifier';
const STORAGE_STATE = 'ship_oauth_state';

/** In-memory token (not persisted). */
let _accessToken: string | null = null;

export function getAccessToken(): string | null {
  return _accessToken;
}

/** Step 1: build the /oauth/authorize URL, stash verifier + state, redirect. */
export async function initiateLogin(): Promise<void> {
  const { verifier, challenge, method } = await generatePkce();
  const state = crypto.randomUUID();

  sessionStorage.setItem(STORAGE_VERIFIER, verifier);
  sessionStorage.setItem(STORAGE_STATE, state);

  const url = new URL(`${BASE_URL}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', method);

  window.location.href = url.toString();
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Step 2: handle the callback URL, exchange the code for tokens.
 * Returns true if a code was present and exchanged; false if already logged in.
 * Throws on error (access_denied, state mismatch, exchange failure).
 */
export async function handleCallback(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;

  const error = params.get('error');
  if (error) throw new Error(`OAuth error: ${error} — ${params.get('error_description') ?? ''}`);

  const state = params.get('state');
  const storedState = sessionStorage.getItem(STORAGE_STATE);
  if (!storedState || state !== storedState) throw new Error('State mismatch — possible CSRF');

  const verifier = sessionStorage.getItem(STORAGE_VERIFIER);
  if (!verifier) throw new Error('PKCE verifier missing from sessionStorage');

  // Clean up before the exchange (so accidental re-runs don't reuse verifier).
  sessionStorage.removeItem(STORAGE_VERIFIER);
  sessionStorage.removeItem(STORAGE_STATE);

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });

  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    throw new Error(`Token exchange failed: ${body.error ?? res.status} — ${body.error_description ?? ''}`);
  }

  const tokens = (await res.json()) as TokenResponse;
  _accessToken = tokens.access_token;

  // Replace the URL to remove the code/state from history (security hygiene).
  window.history.replaceState({}, document.title, window.location.pathname);
  return true;
}
