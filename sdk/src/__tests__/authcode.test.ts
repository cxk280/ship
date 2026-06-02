import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { ShipClient } from '../client.js';
import {
  beginAuthorizationCode,
  completeAuthorizationCode,
  runAuthorizationCodeFlow,
} from '../auth/authcode.js';
import { generatePkce, base64url } from '../auth/pkce.js';

afterEach(() => vi.unstubAllGlobals());

function tokenResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PKCE', () => {
  it('generates an S256 challenge that is base64url(sha256(verifier))', () => {
    const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePkce();
    expect(codeChallengeMethod).toBe('S256');
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/); // url-safe, no padding
    const expected = base64url(createHash('sha256').update(codeVerifier).digest());
    expect(codeChallenge).toBe(expected);
  });
});

describe('beginAuthorizationCode', () => {
  it('builds a spec-correct /oauth/authorize URL and keeps the verifier', () => {
    const { authorizeUrl, codeVerifier, state } = beginAuthorizationCode({
      origin: 'https://ship.test/',
      clientId: 'ship_app_spa',
      redirectUri: 'http://localhost:5180/callback',
      scopes: ['documents:read', 'issues:read'],
      state: 'xyz',
    });
    const u = new URL(authorizeUrl);
    expect(u.origin + u.pathname).toBe('https://ship.test/oauth/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('ship_app_spa');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:5180/callback');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('scope')).toBe('documents:read issues:read');
    expect(u.searchParams.get('state')).toBe('xyz');
    expect(codeVerifier).toBeTruthy();
    expect(state).toBe('xyz');
  });
});

describe('completeAuthorizationCode', () => {
  it('POSTs grant_type=authorization_code with code + verifier and stores tokens', async () => {
    let captured: { url: string; body: string } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        captured = { url: String(url), body: String(init.body) };
        return Promise.resolve(tokenResponse(200, { access_token: 'ship_at_1', token_type: 'Bearer', expires_in: 3600, scope: 'documents:read' }));
      }),
    );
    const result = await completeAuthorizationCode({
      origin: 'https://ship.test',
      clientId: 'ship_app_spa',
      redirectUri: 'http://localhost:5180/callback',
      code: 'the_code',
      codeVerifier: 'the_verifier',
    });
    expect(result.tokens.access_token).toBe('ship_at_1');
    expect(captured!.url).toBe('https://ship.test/oauth/token');
    const form = new URLSearchParams(captured!.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the_code');
    expect(form.get('code_verifier')).toBe('the_verifier');
    expect(form.get('client_id')).toBe('ship_app_spa');
  });

  it('throws a typed auth error when the exchange fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse(400, { error: 'invalid_grant' })));
    await expect(
      completeAuthorizationCode({
        clientId: 'c',
        redirectUri: 'http://localhost/cb',
        code: 'x',
        codeVerifier: 'wrong',
      }),
    ).rejects.toMatchObject({ kind: 'auth', code: 'invalid_grant' });
  });
});

describe('runAuthorizationCodeFlow', () => {
  it('runs begin → authorize → exchange and rejects missing or mismatched state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tokenResponse(200, { access_token: 'ship_at_2', token_type: 'Bearer', expires_in: 3600 })));

    // Happy path: echo the state back.
    const ok = await runAuthorizationCodeFlow({
      origin: 'https://ship.test',
      clientId: 'ship_app_spa',
      redirectUri: 'http://localhost:5180/callback',
      scopes: ['documents:read'],
      authorize: async (url) => {
        const state = new URL(url).searchParams.get('state')!;
        return { code: 'good_code', state };
      },
    });
    expect(ok.tokens.access_token).toBe('ship_at_2');

    // CSRF guard: the redirect state is mandatory, not just best-effort.
    await expect(
      runAuthorizationCodeFlow({
        origin: 'https://ship.test',
        clientId: 'ship_app_spa',
        redirectUri: 'http://localhost:5180/callback',
        authorize: async () => ({ code: 'c' }),
      }),
    ).rejects.toMatchObject({ kind: 'auth', code: 'state_mismatch' });

    // CSRF guard: a wrong state must throw.
    await expect(
      runAuthorizationCodeFlow({
        origin: 'https://ship.test',
        clientId: 'ship_app_spa',
        redirectUri: 'http://localhost:5180/callback',
        authorize: async () => ({ code: 'c', state: 'tampered' }),
      }),
    ).rejects.toMatchObject({ kind: 'auth', code: 'state_mismatch' });
  });

  it('ShipClient.authorizationCodeFlow returns a ready client', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (String(url).endsWith('/oauth/token')) {
          return Promise.resolve(tokenResponse(200, { access_token: 'ship_at_3', token_type: 'Bearer', expires_in: 3600 }));
        }
        return Promise.resolve(tokenResponse(200, { user: { id: 'u1', email: 'a@b.com', name: 'A' }, scopes: ['documents:read'] }));
      }),
    );
    const client = await ShipClient.authorizationCodeFlow({
      origin: 'https://ship.test',
      clientId: 'ship_app_spa',
      redirectUri: 'http://localhost:5180/callback',
      authorize: async (url) => ({ code: 'c', state: new URL(url).searchParams.get('state')! }),
    });
    const me = await client.me();
    expect(me.user?.email).toBe('a@b.com');
  });
});
