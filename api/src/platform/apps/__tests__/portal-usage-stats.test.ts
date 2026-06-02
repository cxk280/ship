/**
 * Portal usage analytics endpoint tests.
 *
 * GET /api/oauth/portal/apps/:appId/usage/stats?window=24h
 *   - Owner gets aggregate stats (total, error rate, p50/p95, top routes).
 *   - Empty window returns zeros (no NaN / divide-by-zero).
 *   - Non-owner gets 404; unauthenticated gets 401.
 *   - Rows without latency_ms are handled gracefully (counted, but skipped by percentile).
 *
 * Seeds api.v1.call audit_logs rows directly (this is exactly the row shape the
 * v1 audit adapter writes).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { pool } from '../../../db/client.js';
import * as ostore from '../../oauth/store.js';
import { hashClientSecret } from '../../oauth/crypto.js';
import { createPortalRouter } from '../portal-routes.js';

function portalApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/oauth/portal', createPortalRouter());
  return a;
}

let ownerToken: string;
let otherToken: string;
let appId: string;
let workspaceId: string;
let ownerId: string;

async function seedCall(
  route: string,
  method: string,
  status: number,
  latencyMs: number | null,
  agoMinutes: number,
) {
  const details: Record<string, unknown> = {
    request_id: crypto.randomBytes(8).toString('hex'),
    method,
    route,
    status,
    scope: 'documents:read',
    app_id: appId,
    client_id: 'ship_app_usage',
  };
  if (latencyMs != null) details.latency_ms = latencyMs;
  await pool.query(
    `INSERT INTO audit_logs
       (workspace_id, actor_user_id, action, resource_type, resource_id, details, created_at)
     VALUES ($1,$2,'api.v1.call','api_route',NULL,$3, now() - ($4 || ' minutes')::interval)`,
    [workspaceId, ownerId, JSON.stringify(details), String(agoMinutes)],
  );
}

beforeAll(async () => {
  const tag = crypto.randomBytes(4).toString('hex');

  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`Usage WS ${tag}`]);
  workspaceId = ws.rows[0].id;

  const ownerUser = await pool.query(
    `INSERT INTO users (email, name) VALUES ($1,'Owner') RETURNING id`,
    [`usage-owner-${tag}@example.com`],
  );
  ownerId = ownerUser.rows[0].id;
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'admin')`,
    [workspaceId, ownerId],
  );
  ownerToken = `ship_${crypto.randomBytes(16).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix)
     VALUES ($1,$2,'usage-owner',$3,$4)`,
    [ownerId, workspaceId, crypto.createHash('sha256').update(ownerToken).digest('hex'), ownerToken.slice(0, 12)],
  );

  const app = await ostore.createApp({
    clientId: `ship_app_usage_${tag}`,
    clientSecretHash: await hashClientSecret('x'),
    name: 'Usage Test App',
    redirectUris: [],
    requestedScopes: ['documents:read'],
    appType: 'confidential',
    ownerUserId: ownerId,
    workspaceId,
  });
  appId = app.id;

  // Second user (non-owner).
  const ws2 = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`Usage Other WS ${tag}`]);
  const otherUser = await pool.query(
    `INSERT INTO users (email, name) VALUES ($1,'Other') RETURNING id`,
    [`usage-other-${tag}@example.com`],
  );
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1,$2,'admin')`,
    [ws2.rows[0].id, otherUser.rows[0].id],
  );
  otherToken = `ship_${crypto.randomBytes(16).toString('hex')}`;
  await pool.query(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix)
     VALUES ($1,$2,'usage-other',$3,$4)`,
    [otherUser.rows[0].id, ws2.rows[0].id,
     crypto.createHash('sha256').update(otherToken).digest('hex'), otherToken.slice(0, 12)],
  );

  // Seed within-window calls (all < 24h ago):
  //   /v1/documents: 5 calls, latencies 10,20,30,40,100 -> p50=30, p95≈88
  //   one of them a 500 error
  await seedCall('/v1/documents', 'GET', 200, 10, 5);
  await seedCall('/v1/documents', 'GET', 200, 20, 6);
  await seedCall('/v1/documents', 'GET', 200, 30, 7);
  await seedCall('/v1/documents', 'GET', 200, 40, 8);
  await seedCall('/v1/documents', 'GET', 500, 100, 9);
  //   /v1/issues: 2 calls, one 404 error, one without latency (legacy row)
  await seedCall('/v1/issues', 'GET', 200, 50, 10);
  await seedCall('/v1/issues', 'GET', 404, null, 11);
  //   one OUTSIDE the 24h window (should be excluded from 24h stats)
  await seedCall('/v1/documents', 'GET', 200, 9999, 60 * 25);
});

describe('GET /api/oauth/portal/apps/:appId/usage/stats', () => {
  it('owner gets aggregate stats over the 24h window', async () => {
    const res = await request(portalApp())
      .get(`/api/oauth/portal/apps/${appId}/usage/stats?window=24h`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(d.window).toBe('24h');
    // 7 calls within window (the 25h-old one excluded).
    expect(d.total_calls).toBe(7);
    expect(d.error_calls).toBe(2); // 500 + 404
    expect(d.error_rate).toBeCloseTo(2 / 7, 5);
    // p50/p95 over rows that recorded latency (6 rows: 10,20,30,40,50,100).
    expect(d.p50_ms).toBeGreaterThan(0);
    expect(d.p95_ms).toBeGreaterThanOrEqual(d.p50_ms);

    // Top routes: documents first (5), issues second (2).
    expect(Array.isArray(d.top_routes)).toBe(true);
    const docs = d.top_routes.find((r: { route: string }) => r.route === '/v1/documents');
    const issues = d.top_routes.find((r: { route: string }) => r.route === '/v1/issues');
    expect(docs.calls).toBe(5);
    expect(docs.errors).toBe(1);
    expect(docs.error_rate).toBeCloseTo(1 / 5, 5);
    expect(issues.calls).toBe(2);
    expect(issues.errors).toBe(1);
    // documents should sort before issues (more calls).
    expect(d.top_routes[0].route).toBe('/v1/documents');
  });

  it('1h window returns zeros (no NaN) when there are no recent calls in a fresh app', async () => {
    const tag = crypto.randomBytes(4).toString('hex');
    const freshApp = await ostore.createApp({
      clientId: `ship_app_fresh_${tag}`, clientSecretHash: await hashClientSecret('x'),
      name: 'Fresh App', redirectUris: [], requestedScopes: ['documents:read'],
      appType: 'confidential', ownerUserId: ownerId, workspaceId,
    });
    const res = await request(portalApp())
      .get(`/api/oauth/portal/apps/${freshApp.id}/usage/stats?window=1h`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.total_calls).toBe(0);
    expect(d.error_calls).toBe(0);
    expect(d.error_rate).toBe(0);
    expect(d.p50_ms).toBeNull();
    expect(d.p95_ms).toBeNull();
    expect(d.top_routes).toEqual([]);
  });

  it('defaults to 24h for an invalid window value', async () => {
    const res = await request(portalApp())
      .get(`/api/oauth/portal/apps/${appId}/usage/stats?window=banana`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.window).toBe('24h');
  });

  it('non-owner gets 404', async () => {
    const res = await request(portalApp())
      .get(`/api/oauth/portal/apps/${appId}/usage/stats?window=24h`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('unauthenticated gets 401', async () => {
    const res = await request(portalApp())
      .get(`/api/oauth/portal/apps/${appId}/usage/stats?window=24h`);
    expect(res.status).toBe(401);
  });
});
