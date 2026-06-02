/**
 * Tests for ensureSubscriptions — idempotency + secret caching.
 *
 * Uses a fake ShipClient (only the .webhooks surface is exercised) and a temp
 * file for the secret cache. No network, no live Ship.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShipClient } from '@ship/sdk';
import { ensureSubscriptions } from '../subscribe.js';

interface FakeSub {
  id: string;
  event_type: string;
  target_url: string;
  active: boolean;
  created_at: string;
}

function fakeClient(initial: FakeSub[] = []) {
  const subs = [...initial];
  let n = 0;
  const deleted: string[] = [];
  const created: { event: string; target_url: string }[] = [];
  const client = {
    webhooks: {
      async list() {
        return subs;
      },
      async create(input: { event: string; target_url: string }) {
        n += 1;
        const id = `sub_${n}`;
        const sub: FakeSub = {
          id,
          event_type: input.event,
          target_url: input.target_url,
          active: true,
          created_at: new Date().toISOString(),
        };
        subs.push(sub);
        created.push(input);
        return { ...sub, signing_secret: `whsec_${input.event}_${n}` };
      },
      async delete(id: string) {
        deleted.push(id);
        const i = subs.findIndex((s) => s.id === id);
        if (i >= 0) subs.splice(i, 1);
      },
    },
  } as unknown as ShipClient;
  return { client, deleted, created, subs };
}

describe('ensureSubscriptions', () => {
  let dir: string;
  let secretFile: string;
  const targetUrl = 'https://bridge.example.com/webhooks/ship';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slack-sub-'));
    secretFile = join(dir, 'secrets.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates missing subscriptions and returns their secrets', async () => {
    const { client, created } = fakeClient();
    const res = await ensureSubscriptions({
      client,
      targetUrl,
      events: ['document.created', 'issue.created'],
      secretFile,
    });

    expect(created).toHaveLength(2);
    expect(Object.keys(res.secrets).sort()).toEqual(['document.created', 'issue.created']);
    expect(res.created.sort()).toEqual(['document.created', 'issue.created']);
    expect(res.reused).toHaveLength(0);
    // secrets persisted to disk
    expect(existsSync(secretFile)).toBe(true);
    const cache = JSON.parse(readFileSync(secretFile, 'utf8'));
    expect(cache.target_url).toBe(targetUrl);
    expect(cache.secrets['document.created']).toMatch(/^whsec_/);
  });

  it('is idempotent: reuses existing subs whose secret is cached', async () => {
    // First run creates them.
    const { client } = fakeClient();
    await ensureSubscriptions({
      client,
      targetUrl,
      events: ['document.created'],
      secretFile,
    });

    // Second run against a client that already lists the subscription + same cache file.
    const existing: FakeSub[] = [
      {
        id: 'sub_existing',
        event_type: 'document.created',
        target_url: targetUrl,
        active: true,
        created_at: new Date().toISOString(),
      },
    ];
    const { client: client2, created } = fakeClient(existing);
    const res = await ensureSubscriptions({
      client: client2,
      targetUrl,
      events: ['document.created'],
      secretFile,
    });

    expect(created).toHaveLength(0); // no new subscription created
    expect(res.reused).toEqual(['document.created']);
    expect(res.secrets['document.created']).toMatch(/^whsec_/);
  });

  it('recreates a subscription when its secret is not cached (deletes the stale one)', async () => {
    const existing: FakeSub[] = [
      {
        id: 'sub_orphan',
        event_type: 'document.created',
        target_url: targetUrl,
        active: true,
        created_at: new Date().toISOString(),
      },
    ];
    const { client, deleted, created } = fakeClient(existing);
    const res = await ensureSubscriptions({
      client,
      targetUrl,
      events: ['document.created'],
      secretFile, // empty cache → no secret known
    });

    expect(deleted).toEqual(['sub_orphan']);
    expect(created).toHaveLength(1);
    expect(res.created).toEqual(['document.created']);
    expect(res.secrets['document.created']).toMatch(/^whsec_/);
  });

  it('discards cached secrets when the target URL changes', async () => {
    const { client } = fakeClient();
    await ensureSubscriptions({
      client,
      targetUrl,
      events: ['document.created'],
      secretFile,
    });

    // New target → cache invalidated → fresh create.
    const newTarget = 'https://new.example.com/webhooks/ship';
    const { client: client2, created } = fakeClient();
    const res = await ensureSubscriptions({
      client: client2,
      targetUrl: newTarget,
      events: ['document.created'],
      secretFile,
    });

    expect(created).toHaveLength(1);
    const cache = JSON.parse(readFileSync(secretFile, 'utf8'));
    expect(cache.target_url).toBe(newTarget);
    expect(res.secrets['document.created']).toMatch(/^whsec_/);
  });
});
