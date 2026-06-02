/**
 * Tests for B7 SDK polish:
 *  1. Auto-retry with backoff (429 + Retry-After, 503×2, 400 no-retry, cap exceeded)
 *  2. AbortSignal support (pre-aborted signal rejects immediately)
 *  3. request_id on every error (from body + from X-Request-Id header)
 *  4. Typed webhook events (parseWebhookEvent discriminated union)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ShipClient } from '../client.js';
import { ShipError } from '../errors.js';
import { Http } from '../http.js';
import { InMemoryTokenStore } from '../token-store.js';
import { parseWebhookEvent } from '../webhooks/events.js';

// ---- helpers ----------------------------------------------------------------

type HeadersLike = { get(name: string): string | null };

function fakeHeaders(map: Record<string, string> = {}): HeadersLike {
  return {
    get(name: string) {
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(map)) {
        if (k.toLowerCase() === lower) return v;
      }
      return null;
    },
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: fakeHeaders(headers),
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

// ---- 1. Auto-retry ----------------------------------------------------------

describe('auto-retry', () => {
  beforeEach(() => {
    // Speed up back-off by zeroing Math.random so backoffMs returns 0.5× base.
    // We override the actual delay via a zero-delay stub anyway.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries on 429 and honors Retry-After header', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { code: 'rate_limited', message: 'slow down' }, { 'Retry-After': '0' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ShipClient({ token: 't', baseUrl: 'https://ship.test', maxRetries: 3 });
    const result = await client.me() as unknown as { ok: boolean };
    // Should have called fetch twice (first attempt + one retry).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('retries on 429 without Retry-After using exponential back-off', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(429, { code: 'rate_limited', message: 'slow' }))
      .mockResolvedValueOnce(jsonResponse(200, { user: null, app: { client_id: 'x' }, scopes: [], workspace_id: null }));
    vi.stubGlobal('fetch', fetchMock);

    // Use an Http directly so we don't need a full me() response shape.
    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }), maxRetries: 3 });
    // Override backoffMs by spying — we just want to confirm two calls happened.
    const result = await http.request<{ user: null }>('GET', '/me');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ user: null });
  });

  it('retries 503 × 2 then succeeds on 200', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(503, { code: 'service_unavailable', message: 'down' }))
      .mockResolvedValueOnce(jsonResponse(503, { code: 'service_unavailable', message: 'down' }))
      .mockResolvedValueOnce(jsonResponse(200, { user: null, app: { client_id: 'x' }, scopes: [], workspace_id: null }));
    vi.stubGlobal('fetch', fetchMock);

    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }), maxRetries: 3 });
    const result = await http.request<{ user: null }>('GET', '/me');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ user: null });
  });

  it('does NOT retry on 400 (non-retryable 4xx)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(400, { code: 'invalid_request', message: 'bad' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }), maxRetries: 3 });
    await expect(http.request('GET', '/me')).rejects.toMatchObject({ kind: 'validation', status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 404', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(404, { code: 'not_found', message: 'gone' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }), maxRetries: 3 });
    await expect(http.request('GET', '/me')).rejects.toMatchObject({ kind: 'not_found', status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting maxRetries cap (3 retries = 4 total calls)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(503, { code: 'service_unavailable', message: 'down' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }), maxRetries: 3 });
    const err = await http.request('GET', '/me').catch((e) => e) as ShipError;
    expect(err).toBeInstanceOf(ShipError);
    expect(err.kind).toBe('server');
    expect(err.status).toBe(503);
    // 1 original + 3 retries = 4 total
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('maxRetries: 0 disables retries entirely', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(503, { code: 'service_unavailable', message: 'down' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }), maxRetries: 0 });
    await expect(http.request('GET', '/me')).rejects.toMatchObject({ kind: 'server', status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries transient network errors', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(200, { user: null, app: { client_id: 'x' }, scopes: [], workspace_id: null }));
    vi.stubGlobal('fetch', fetchMock);

    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }), maxRetries: 3 });
    const result = await http.request<{ user: null }>('GET', '/me');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ user: null });
  });
});

// ---- 2. AbortSignal support -------------------------------------------------

describe('AbortSignal support', () => {
  it('rejects immediately when signal is already aborted', async () => {
    const fetchMock = vi.fn(); // should never be called
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    controller.abort();

    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }) });
    const err = await http.request('GET', '/me', { signal: controller.signal }).catch((e) => e) as ShipError;

    expect(err).toBeInstanceOf(ShipError);
    expect(err.kind).toBe('network');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates AbortError from fetch as a network ShipError', async () => {
    const abortError = new Error('The user aborted a request.');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }), maxRetries: 0 });
    const err = await http.request('GET', '/me').catch((e) => e) as ShipError;

    expect(err).toBeInstanceOf(ShipError);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('aborted');
  });

  it('passes signal through to fetch', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { user: null, app: { client_id: 'x' }, scopes: [], workspace_id: null }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }) });
    await http.request('GET', '/me', { signal: controller.signal });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).signal).toBe(controller.signal);
  });
});

// ---- 3. request_id on every error -------------------------------------------

describe('request_id on errors', () => {
  it('captures request_id from ApiError body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(404, { code: 'not_found', message: 'nope', request_id: 'req_abc123' }),
    ));

    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }) });
    const err = await http.request('GET', '/documents/missing').catch((e) => e) as ShipError;

    expect(err).toBeInstanceOf(ShipError);
    expect(err.kind).toBe('not_found');
    expect(err.requestId).toBe('req_abc123');
  });

  it('falls back to X-Request-Id response header when body has no request_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: fakeHeaders({ 'X-Request-Id': 'header-req-xyz' }),
      json: async () => ({ code: 'server_error', message: 'oops' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }), maxRetries: 0 });
    const err = await http.request('GET', '/me').catch((e) => e) as ShipError;

    expect(err).toBeInstanceOf(ShipError);
    expect(err.requestId).toBe('header-req-xyz');
  });

  it('body request_id takes precedence over header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: fakeHeaders({ 'X-Request-Id': 'header-id' }),
      json: async () => ({ code: 'invalid_request', message: 'bad', request_id: 'body-id' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const http = new Http({ origin: 'https://ship.test', tokenStore: new InMemoryTokenStore({ access_token: 't' }) });
    const err = await http.request('GET', '/me').catch((e) => e) as ShipError;

    expect(err.requestId).toBe('body-id');
  });
});

// ---- 4. Typed webhook events ------------------------------------------------

describe('parseWebhookEvent', () => {
  it('parses document.created and narrows data type', () => {
    const doc = {
      id: 'doc1',
      document_type: 'wiki',
      title: 'Hello',
      properties: {},
      parent_id: null,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };
    const raw = JSON.stringify({ type: 'document.created', data: { document: doc } });
    const event = parseWebhookEvent(raw);

    expect(event.type).toBe('document.created');
    if (event.type === 'document.created') {
      expect(event.data.document.id).toBe('doc1');
      expect(event.data.document.title).toBe('Hello');
    }
  });

  it('parses issue.assigned and narrows data type', () => {
    const issue = {
      id: 'iss1',
      title: 'Bug',
      state: 'in_progress',
      priority: 'high',
      assignee_id: 'u2',
      due_date: null,
      properties: {},
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };
    const raw = JSON.stringify({ type: 'issue.assigned', data: { issue, previous_assignee_id: null } });
    const event = parseWebhookEvent(raw);

    expect(event.type).toBe('issue.assigned');
    if (event.type === 'issue.assigned') {
      expect(event.data.issue.id).toBe('iss1');
      expect(event.data.previous_assignee_id).toBeNull();
    }
  });

  it('parses sprint.completed', () => {
    const sprint = {
      id: 'sp1',
      title: 'Sprint 1',
      status: 'completed',
      sprint_number: 1,
      start_date: '2025-01-01',
      end_date: '2025-01-14',
      properties: {},
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-14T00:00:00Z',
    };
    const raw = JSON.stringify({ type: 'sprint.completed', data: { sprint, issues_carried_over: 3 } });
    const event = parseWebhookEvent(raw);

    expect(event.type).toBe('sprint.completed');
    if (event.type === 'sprint.completed') {
      expect(event.data.issues_carried_over).toBe(3);
    }
  });

  it('returns an unknown variant for unrecognized event types', () => {
    const raw = JSON.stringify({ type: 'billing.invoice_paid', data: { amount: 100 } });
    const event = parseWebhookEvent(raw);

    expect(event.type).toBe('unknown');
    if (event.type === 'unknown') {
      expect(event.rawType).toBe('billing.invoice_paid');
      expect((event.data as { amount: number }).amount).toBe(100);
    }
  });

  it('throws TypeError for invalid JSON', () => {
    expect(() => parseWebhookEvent('{bad json')).toThrow(TypeError);
    expect(() => parseWebhookEvent('{bad json')).toThrow(/not valid JSON/);
  });

  it('throws TypeError when "type" field is missing', () => {
    const raw = JSON.stringify({ data: {} });
    expect(() => parseWebhookEvent(raw)).toThrow(TypeError);
    expect(() => parseWebhookEvent(raw)).toThrow(/"type"/);
  });

  it('throws TypeError when "data" field is missing', () => {
    const raw = JSON.stringify({ type: 'document.created' });
    expect(() => parseWebhookEvent(raw)).toThrow(TypeError);
    expect(() => parseWebhookEvent(raw)).toThrow(/"data"/);
  });
});

// ---- Integration: ShipClient exposes maxRetries option ----------------------

describe('ShipClient maxRetries option', () => {
  it('passes maxRetries: 0 through to http layer (no retries)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(503, { code: 'service_unavailable', message: 'down' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ShipClient({ token: 't', baseUrl: 'https://ship.test', maxRetries: 0 });
    await expect(client.me()).rejects.toMatchObject({ kind: 'server', status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
