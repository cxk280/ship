/**
 * Portal "send test event" endpoint tests.
 *
 * POST /api/oauth/portal/apps/:appId/subscriptions/:subId/test
 *   - Owner gets a delivery record back (ownership verified via resolveOwnedApp).
 *   - Non-owner (different user) gets 404.
 *
 * Uses supertest + a fake/null transport so no real HTTP is sent to target URLs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { pool } from '../../../db/client.js';
import * as wstore from '../../webhooks/store.js';
import * as ostore from '../../oauth/store.js';
import { hashClientSecret } from '../../oauth/crypto.js';
import { createPortalRouter, setPortalEventBusForTest } from '../portal-routes.js';
import { QueueWebhookDeliverer, type Transport } from '../../webhooks/deliverer.js';
import { InMemoryEventBus } from '../../webhooks/event-bus.js';
import { systemClock } from '../../webhooks/clock.js';

// A transport that immediately returns 200 (no real HTTP).
const okTransport: Transport = async () => ({ status: 200 });

function portalApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/oauth/portal', createPortalRouter());
  return a;
}

let ownerToken: string;
let otherToken: string;
let appId: string;
let subId: string;

beforeAll(async () => {
  const tag = crypto.randomBytes(4).toString('hex');

  // Owner user + workspace + app + subscription
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`Portal Test WS ${tag}`]);
  const workspaceId = ws.rows[0].id;

  const ownerUser = await pool.query(
    `INSERT INTO users (email, name) VALUES ($1,'Owner') RETURNING id`,
    [`portal-owner-${tag}@example.com`],
  );
  const ownerId = ownerUser.rows[0].id;

  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'admin')`,
    [workspaceId, ownerId],
  );

  ownerToken = `ship_${crypto.randomBytes(16).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix)
     VALUES ($1,$2,'portal-test-owner',$3,$4)`,
    [ownerId, workspaceId, crypto.createHash('sha256').update(ownerToken).digest('hex'), ownerToken.slice(0, 12)],
  );

  const app = await ostore.createApp({
    clientId: `ship_app_portal_${tag}`,
    clientSecretHash: await hashClientSecret('x'),
    name: 'Portal Test App',
    redirectUris: [],
    requestedScopes: ['webhooks:manage'],
    appType: 'confidential',
    ownerUserId: ownerId,
    workspaceId,
  });
  appId = app.id;

  const sub = await wstore.createSubscription({
    appId: app.id,
    workspaceId,
    eventType: 'document.created',
    targetUrl: 'https://portal-test.example.com/hook',
    signingSecret: 'whsec_portal_test',
  });
  subId = sub.id;

  // A second user who does NOT own the app.
  const ws2 = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`Portal Other WS ${tag}`]);
  const otherUser = await pool.query(
    `INSERT INTO users (email, name) VALUES ($1,'Other') RETURNING id`,
    [`portal-other-${tag}@example.com`],
  );
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'admin')`,
    [ws2.rows[0].id, otherUser.rows[0].id],
  );
  otherToken = `ship_${crypto.randomBytes(16).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix)
     VALUES ($1,$2,'portal-test-other',$3,$4)`,
    [otherUser.rows[0].id, ws2.rows[0].id,
     crypto.createHash('sha256').update(otherToken).digest('hex'), otherToken.slice(0, 12)],
  );

  // Inject a bus backed by an instant-ok transport so no real HTTP is sent.
  const deliverer = new QueueWebhookDeliverer({ clock: systemClock, transport: okTransport, jitter: () => 0 });
  const bus = new InMemoryEventBus({ deliverer, clock: systemClock });
  setPortalEventBusForTest(bus);
});

describe('POST /api/oauth/portal/apps/:appId/subscriptions/:subId/test', () => {
  it('owner receives a delivery record for the test event', async () => {
    const res = await request(portalApp())
      .post(`/api/oauth/portal/apps/${appId}/subscriptions/${subId}/test`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const delivery = res.body.data;
    expect(delivery).toBeTruthy();
    expect(delivery.subscription_id).toBe(subId);
    expect(delivery.event_type).toBe('document.created');
    // idempotency_key should start with 'test_' (as set by sendTestEvent)
    expect(delivery.idempotency_key).toMatch(/^test_/);
  });

  it('non-owner gets 404 for the app', async () => {
    const res = await request(portalApp())
      .post(`/api/oauth/portal/apps/${appId}/subscriptions/${subId}/test`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('owner gets 404 for a subscription that does not belong to the app', async () => {
    // Create a subscription on a DIFFERENT app.
    const tag = crypto.randomBytes(4).toString('hex');
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`Other App WS ${tag}`]);
    const u = await pool.query(
      `INSERT INTO users (email, name) VALUES ($1,'U') RETURNING id`,
      [`other-app-${tag}@example.com`],
    );
    const otherApp = await ostore.createApp({
      clientId: `ship_app_other_${tag}`, clientSecretHash: await hashClientSecret('x'),
      name: 'Other App', redirectUris: [], requestedScopes: ['webhooks:manage'],
      appType: 'confidential', ownerUserId: u.rows[0].id, workspaceId: ws.rows[0].id,
    });
    const foreignSub = await wstore.createSubscription({
      appId: otherApp.id, workspaceId: ws.rows[0].id, eventType: 'document.created',
      targetUrl: 'https://foreign.example.com/hook', signingSecret: 'whsec_foreign',
    });

    const res = await request(portalApp())
      .post(`/api/oauth/portal/apps/${appId}/subscriptions/${foreignSub.id}/test`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});

    // The subscription belongs to a different app — should 404.
    expect(res.status).toBe(404);
  });

  it('returns 401 when called without authentication', async () => {
    const res = await request(portalApp())
      .post(`/api/oauth/portal/apps/${appId}/subscriptions/${subId}/test`)
      .send({});

    expect(res.status).toBe(401);
  });
});
