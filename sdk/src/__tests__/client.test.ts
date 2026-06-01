import { describe, it, expect, vi, afterEach } from 'vitest';
import { ShipClient } from '../client.js';
import { ShipError } from '../errors.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('ShipClient.me()', () => {
  it('sends the bearer token and returns the typed principal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        user: { id: 'u1', email: 'a@b.com', name: 'A' },
        app: { client_id: 'ship_app_x' },
        scopes: ['documents:read'],
        workspace_id: 'ws1',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ShipClient({ token: 'ship_at_abc', baseUrl: 'https://ship.test' });
    const me = await client.me();

    expect(me.user?.email).toBe('a@b.com');
    expect(me.scopes).toEqual(['documents:read']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://ship.test/api/v1/me');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer ship_at_abc' });
  });

  it('maps a 401 ApiError to a typed auth ShipError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(401, { code: 'unauthorized', message: 'nope', request_id: 'r1' }),
    ));
    const client = new ShipClient({ token: 'bad', baseUrl: 'https://ship.test' });
    await expect(client.me()).rejects.toMatchObject({ kind: 'auth', status: 401, code: 'unauthorized' });
  });
});

describe('documents.iterate()', () => {
  it('walks pages transparently using next_cursor', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'd1' }, { id: 'd2' }], next_cursor: 'CURSOR2' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 'd3' }], next_cursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ShipClient({ token: 't', baseUrl: 'https://ship.test' });
    const ids: string[] = [];
    for await (const doc of client.documents.iterate({ limit: 2 })) ids.push(doc.id);

    expect(ids).toEqual(['d1', 'd2', 'd3']);
    // second call carried the cursor
    const secondUrl = fetchMock.mock.calls[1]![0] as string;
    expect(secondUrl).toContain('cursor=CURSOR2');
  });
});

describe('ShipError', () => {
  it('is a discriminated union switchable on kind', () => {
    const e = ShipError.fromResponse(429, { code: 'rate_limited', message: 'slow down' });
    expect(e.kind).toBe('rate_limit');
  });
});
