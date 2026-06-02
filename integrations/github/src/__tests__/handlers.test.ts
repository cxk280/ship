/**
 * Route-level tests for the GitHub bridge server. Exercises signature
 * verification on both endpoints with a fake GitHub + Ship client.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { computeSignature } from '@ship/sdk';
import type { ShipClient } from '@ship/sdk';
import type { Express } from 'express';
import { GitHubClient } from '../github.js';
import { createApp, type MutableDeps } from '../server.js';

const SHIP_SECRET = 'whsec_gh_test';
const GH_SECRET = 'gh_hook_secret';

function fakeGitHubFetch(): typeof fetch {
  let n = 0;
  const issues: { number: number; body: string | null }[] = [];
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = (typeof url === 'string' ? url : url.toString()).replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    if (method === 'GET' && u.startsWith('/search/issues')) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    if (method === 'POST' && /\/issues$/.test(u)) {
      n += 1;
      const b = JSON.parse(String(init?.body));
      issues.push({ number: n, body: b.body });
      return new Response(JSON.stringify({ number: n, title: b.title, body: b.body, state: 'open', html_url: `https://github.com/o/r/issues/${n}` }), { status: 200 });
    }
    if (method === 'PATCH') {
      return new Response(JSON.stringify({ number: 1, state: 'open', html_url: 'x' }), { status: 200 });
    }
    return new Response('nf', { status: 404 });
  }) as typeof fetch;
}

function fakeShip(): ShipClient {
  let n = 0;
  return {
    documents: {
      async create(input: unknown) {
        n += 1;
        return { id: `doc_${n}`, title: (input as { title: string }).title };
      },
    },
  } as unknown as ShipClient;
}

function makeApp(): Express {
  const deps: MutableDeps = {
    ship: fakeShip(),
    github: new GitHubClient({ token: 't', repo: 'o/r', fetchImpl: fakeGitHubFetch() }),
    shipBaseUrl: 'https://ship.example.com',
    shipSigningSecrets: [SHIP_SECRET],
    githubWebhookSecret: GH_SECRET,
  };
  return createApp(deps);
}

async function post(app: Express, path: string, headers: Record<string, string>, body: string) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  server.close();
  return { status: res.status, body: json };
}

describe('POST /webhooks/ship (Ship → GitHub)', () => {
  function shipBody(type: string, data: Record<string, unknown>) {
    return JSON.stringify({ id: 'evt_1', type, created: Math.floor(Date.now() / 1000), data });
  }
  function shipHeaders(body: string) {
    const t = Math.floor(Date.now() / 1000);
    return { 'Content-Type': 'application/json', 'Ship-Signature': `t=${t},v1=${computeSignature(SHIP_SECRET, t, body)}` };
  }

  it('mirrors an issue.created event → 200 created', async () => {
    const body = shipBody('issue.created', { id: 'ship-1', title: 'Fix it', document_type: 'issue', workspace_id: 'w' });
    const res = await post(makeApp(), '/webhooks/ship', shipHeaders(body), body);
    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(true);
    expect(res.body.action).toBe('created');
  });

  it('rejects a bad Ship signature → 400', async () => {
    const body = shipBody('issue.created', { id: 'ship-1', title: 'Fix it' });
    const res = await post(makeApp(), '/webhooks/ship', { 'Content-Type': 'application/json', 'Ship-Signature': 't=1,v1=deadbeef' }, body);
    expect(res.status).toBe(400);
  });

  it('ignores non-issue events → handled:false', async () => {
    const body = shipBody('document.created', { id: 'd', title: 'wiki', document_type: 'wiki', workspace_id: 'w' });
    const res = await post(makeApp(), '/webhooks/ship', shipHeaders(body), body);
    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(false);
  });
});

describe('POST /webhooks/github (GitHub → Ship)', () => {
  function ghHeaders(body: string, event: string) {
    return {
      'Content-Type': 'application/json',
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', GH_SECRET).update(body).digest('hex'),
    };
  }

  it('links a PR that references a Ship issue → 200 linked', async () => {
    const body = JSON.stringify({
      action: 'opened',
      pull_request: { number: 5, title: 'fix', body: 'Closes ship#ship-1', html_url: 'https://github.com/o/r/pull/5' },
      repository: { full_name: 'o/r' },
    });
    const res = await post(makeApp(), '/webhooks/github', ghHeaders(body, 'pull_request'), body);
    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(true);
    expect(res.body.shipIssueId).toBe('ship-1');
  });

  it('rejects a bad GitHub signature → 400', async () => {
    const body = JSON.stringify({ action: 'opened', pull_request: { number: 5, title: 't', body: 'ship#x', html_url: 'u' } });
    const res = await post(makeApp(), '/webhooks/github', { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': 'sha256=bad' }, body);
    expect(res.status).toBe(400);
  });

  it('answers a ping → pong', async () => {
    const body = JSON.stringify({ zen: 'hi' });
    const res = await post(makeApp(), '/webhooks/github', ghHeaders(body, 'ping'), body);
    expect(res.status).toBe(200);
    expect(res.body.pong).toBe(true);
  });
});
