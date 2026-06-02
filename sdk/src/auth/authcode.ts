/**
 * Authorization Code + PKCE (RFC 6749 §4.1 + RFC 7636) client helper — the flow
 * behind a browser SPA or a native/CLI app that can receive a redirect.
 *
 * It's split into composable pieces so it works in any environment:
 *   beginAuthorizationCode()    → builds the /oauth/authorize URL + PKCE verifier
 *   completeAuthorizationCode() → exchanges code + verifier at /oauth/token
 *   runAuthorizationCodeFlow()  → orchestrates both, given an `authorize` callback
 *                                  that drives the user agent and returns the code.
 *
 * The `authorize` callback is environment-specific: a SPA performs a redirect, a
 * CLI spins a loopback listener (RFC 8252), a test passes the code directly.
 */
import { ShipError } from '../errors.js';
import { InMemoryTokenStore, type ITokenStore, type StoredTokens } from '../token-store.js';
import { generatePkce, randomState } from './pkce.js';

export interface BeginAuthorizationCodeOptions {
  /** Server origin, default http://localhost:3000. */
  origin?: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  /** Provide your own CSRF state; one is generated otherwise. */
  state?: string;
}

export interface AuthorizationRequest {
  authorizeUrl: string;
  codeVerifier: string;
  state: string;
}

/** Build the /oauth/authorize URL and the PKCE verifier to keep for the exchange. */
export function beginAuthorizationCode(opts: BeginAuthorizationCodeOptions): AuthorizationRequest {
  const origin = (opts.origin ?? 'http://localhost:3000').replace(/\/$/, '');
  const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePkce();
  const state = opts.state ?? randomState();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    state,
  });
  if (opts.scopes?.length) q.set('scope', opts.scopes.join(' '));
  return { authorizeUrl: `${origin}/oauth/authorize?${q.toString()}`, codeVerifier, state };
}

export interface CompleteAuthorizationCodeOptions {
  origin?: string;
  clientId: string;
  /** Confidential clients only; public (PKCE) clients omit it. */
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  tokenStore?: ITokenStore;
}

export interface AuthorizationCodeResult {
  origin: string;
  tokenStore: ITokenStore;
  tokens: StoredTokens;
}

/** Exchange an authorization code + PKCE verifier for tokens at /oauth/token. */
export async function completeAuthorizationCode(
  opts: CompleteAuthorizationCodeOptions,
): Promise<AuthorizationCodeResult> {
  const origin = (opts.origin ?? 'http://localhost:3000').replace(/\/$/, '');
  const tokenStore = opts.tokenStore ?? new InMemoryTokenStore();

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
    client_id: opts.clientId,
  });
  if (opts.clientSecret) form.set('client_secret', opts.clientSecret);

  const res = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, string> & { expires_in?: number };

  if (!res.ok) {
    throw new ShipError({
      kind: 'auth',
      status: res.status,
      code: data.error ?? 'invalid_grant',
      message: data.error_description ?? 'Authorization code exchange failed',
    });
  }

  const tokens: StoredTokens = {
    access_token: data.access_token!,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined,
    scope: data.scope,
  };
  await tokenStore.set(tokens);
  return { origin, tokenStore, tokens };
}

export interface AuthorizationCodeFlowOptions extends BeginAuthorizationCodeOptions {
  clientSecret?: string;
  tokenStore?: ITokenStore;
  /**
   * Drive the user agent to `authorizeUrl` and resolve with the `code` (and, if
   * available, the `state`) returned on the redirect. The `state` is required
   * and verified against the one we generated to defend against CSRF.
   */
  authorize: (authorizeUrl: string) => Promise<{ code: string; state?: string }>;
}

/** Run the whole Authorization Code + PKCE flow end-to-end. */
export async function runAuthorizationCodeFlow(
  opts: AuthorizationCodeFlowOptions,
): Promise<AuthorizationCodeResult> {
  const { authorizeUrl, codeVerifier, state } = beginAuthorizationCode(opts);
  const result = await opts.authorize(authorizeUrl);
  if (result.state !== state) {
    throw new ShipError({
      kind: 'auth',
      status: 400,
      code: 'state_mismatch',
      message: 'OAuth state missing or mismatched on the authorization redirect (possible CSRF)',
    });
  }
  return completeAuthorizationCode({
    origin: opts.origin,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    redirectUri: opts.redirectUri,
    code: result.code,
    codeVerifier,
    tokenStore: opts.tokenStore,
  });
}
