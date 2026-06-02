/**
 * /api/v1/webhooks routes + the end-to-end loop: subscribe → create a document →
 * a signed delivery is logged → replay. This is the TTFE loop over HTTP.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import * as ostore from '../../../oauth/store.js';
import { hashClientSecret, sha256, generate } from '../../../oauth/crypto.js';
import { bearerAuth } from '../../../oauth/bearer.js';
import { identityAdapter } from '../../../adapters/identity.js';
import { createDocumentsAdapter } from '../../../adapters/documents.js';
import { createWebhooksAdapter } from '../../../adapters/webhooks.js';
import { systemClock } from '../../../webhooks/clock.js';
import { QueueWebhookDeliverer, type Transport } from '../../../webhooks/deliverer.js';
import { InMemoryEventBus } from '../../../webhooks/event-bus.js';
import { createV1Router } from '../router.js';

let workspaceId: string;
let userId: string;
let appId: string;

const noRateLimit = (_req: unknown, _res: unknown, next: () => void) => next();
const okTransport: Transport = async () => ({ status: 200 });

function v1App() {
  const deliverer = new QueueWebhookDeliverer({ clock: systemClock, transport: okTransport, jitter: () => 0 });
  const bus = new InMemoryEventBus({ deliverer, clock: systemClock });
  const a = express();
  a.use('/api/v1', createV1Router({
    bearerAuth, rateLimit: noRateLimit, identity: identityAdapter,
    documents: createDocumentsAdapter(bus), webhooks: createWebhooksAdapter(bus),
  }));
  return a;
}

async function mintToken(scopes: string[]): Promise<string> {
  const raw = generate.accessToken();
  await ostore.insertAccessToken({
    tokenHash: sha256(raw), appId, userId, workspaceId, scopes,
    grantType: 'authorization_code', expiresAt: new Date(Date.now() + 3600_000),
  });
  return raw;
}

const tick = () => new Promise((r) => setTimeout(r, 60));

/** Mint a token for a SHARED app (workspace_id NULL) but a specific workspace. */
async function mintSharedAppToken(sharedAppId: string, wsId: string): Promise<string> {
  const u = await pool.query(`INSERT INTO users (email, name) VALUES ($1,'X') RETURNING id`, [`u-${wsId}@example.com`]);
  const raw = generate.accessToken();
  await ostore.insertAccessToken({
    tokenHash: sha256(raw), appId: sharedAppId, userId: u.rows[0].id, workspaceId: wsId,
    scopes: ['webhooks:manage'], grantType: 'device_code', expiresAt: new Date(Date.now() + 3600_000),
  });
  return raw;
}

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('WH routes WS') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const u = await pool.query(`INSERT INTO users (email, name) VALUES ('wh-routes@example.com','WH') RETURNING id`);
  userId = u.rows[0].id;
  const app = await ostore.createApp({
    clientId: 'ship_app_wh_routes', clientSecretHash: await hashClientSecret('x'), name: 'WH Routes App',
    redirectUris: [], requestedScopes: ['webhooks:manage', 'documents:write'], appType: 'confidential',
    ownerUserId: userId, workspaceId,
  });
  appId = app.id;
});

describe('webhook subscription management', () => {
  it('creates a subscription (201, secret once), lists it, and deletes it', async () => {
    const token = await mintToken(['webhooks:manage']);
    const created = await request(v1App()).post('/api/v1/webhooks')
      .set('Authorization', `Bearer ${token}`)
      .send({ event_type: 'document.created', target_url: 'https://sub.example.com/hook' });
    expect(created.status).toBe(201);
    expect(created.body.signing_secret).toMatch(/^whsec_/);
    expect(created.body.warning).toContain('not be shown again');
    const id = created.body.id;

    const list = await request(v1App()).get('/api/v1/webhooks').set('Authorization', `Bearer ${token}`);
    expect(list.body.data.some((s: { id: string }) => s.id === id)).toBe(true);
    // list never leaks the secret
    expect(JSON.stringify(list.body)).not.toContain('whsec_');

    const del = await request(v1App()).delete(`/api/v1/webhooks/${id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
  });

  it('rejects an unknown event_type with validation_failed', async () => {
    const token = await mintToken(['webhooks:manage']);
    const res = await request(v1App()).post('/api/v1/webhooks')
      .set('Authorization', `Bearer ${token}`)
      .send({ event_type: 'document.exploded', target_url: 'https://x.example.com' });
    expect(res.status).toBe(400);
  });

  it('403s without webhooks:manage, naming the missing scope', async () => {
    const token = await mintToken(['documents:read']);
    const res = await request(v1App()).post('/api/v1/webhooks')
      .set('Authorization', `Bearer ${token}`)
      .send({ event_type: 'document.created', target_url: 'https://x.example.com' });
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('webhooks:manage');
  });
});

describe('end-to-end: subscribe → create document → signed delivery → replay', () => {
  it('logs a delivered webhook after a document is created, and can replay it', async () => {
    const token = await mintToken(['webhooks:manage', 'documents:write']);
    const app = v1App();

    await request(app).post('/api/v1/webhooks').set('Authorization', `Bearer ${token}`)
      .send({ event_type: 'document.created', target_url: 'https://sub.example.com/hook' }).expect(201);

    await request(app).post('/api/v1/documents').set('Authorization', `Bearer ${token}`)
      .send({ title: 'Triggers a webhook', document_type: 'wiki' }).expect(201);

    await tick(); // let the (setTimeout(0)) delivery fire

    const deliveries = await request(app).get('/api/v1/webhooks/deliveries').set('Authorization', `Bearer ${token}`);
    expect(deliveries.status).toBe(200);
    const delivered = deliveries.body.data.find((d: { status: string }) => d.status === 'delivered');
    expect(delivered, 'a delivery should be logged as delivered').toBeTruthy();

    const replay = await request(app).post(`/api/v1/webhooks/deliveries/${delivered.id}/replay`)
      .set('Authorization', `Bearer ${token}`).send({});
    expect(replay.status).toBe(202);
  });

  it('isolates subscriptions across workspaces for a SHARED app (e.g. the CLI)', async () => {
    // One app (workspace_id NULL) used by two workspaces — like ship_app_cli.
    const shared = await ostore.createApp({
      clientId: `ship_app_shared_${Date.now()}`, clientSecretHash: await hashClientSecret('x'),
      name: 'Shared', redirectUris: [], requestedScopes: ['webhooks:manage'], appType: 'public',
      ownerUserId: null, workspaceId: null,
    });
    const wsA = (await pool.query(`INSERT INTO workspaces (name) VALUES ('iso A') RETURNING id`)).rows[0].id;
    const wsB = (await pool.query(`INSERT INTO workspaces (name) VALUES ('iso B') RETURNING id`)).rows[0].id;
    const tokenA = await mintSharedAppToken(shared.id, wsA);
    const tokenB = await mintSharedAppToken(shared.id, wsB);

    const subA = await request(v1App()).post('/api/v1/webhooks').set('Authorization', `Bearer ${tokenA}`)
      .send({ event_type: 'document.created', target_url: 'https://a.example.com/hook' }).expect(201);

    // Workspace B (same app id!) must NOT see workspace A's subscription.
    const listB = await request(v1App()).get('/api/v1/webhooks').set('Authorization', `Bearer ${tokenB}`);
    expect(listB.body.data.some((s: { id: string }) => s.id === subA.body.id)).toBe(false);
    // ...and can't delete it.
    const delB = await request(v1App()).delete(`/api/v1/webhooks/${subA.body.id}`).set('Authorization', `Bearer ${tokenB}`);
    expect(delB.status).toBe(404);
    // Workspace A still sees its own.
    const listA = await request(v1App()).get('/api/v1/webhooks').set('Authorization', `Bearer ${tokenA}`);
    expect(listA.body.data.some((s: { id: string }) => s.id === subA.body.id)).toBe(true);
  });

  it('refuses to replay a delivery whose subscription was deleted', async () => {
    const token = await mintToken(['webhooks:manage', 'documents:write']);
    const app = v1App();
    const sub = await request(app).post('/api/v1/webhooks').set('Authorization', `Bearer ${token}`)
      .send({ event_type: 'document.created', target_url: 'https://sub2.example.com/hook' }).expect(201);
    await request(app).post('/api/v1/documents').set('Authorization', `Bearer ${token}`)
      .send({ title: 'doc', document_type: 'wiki' }).expect(201);
    await tick();
    const deliveries = await request(app).get('/api/v1/webhooks/deliveries').set('Authorization', `Bearer ${token}`);
    const d = deliveries.body.data[0];

    await request(app).delete(`/api/v1/webhooks/${sub.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);

    const replay = await request(app).post(`/api/v1/webhooks/deliveries/${d.id}/replay`)
      .set('Authorization', `Bearer ${token}`).send({});
    expect(replay.status).toBe(404); // deleted subscription can't be replayed
  });
});
