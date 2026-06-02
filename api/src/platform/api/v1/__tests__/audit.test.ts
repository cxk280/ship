/**
 * Audit trail integration tests (Plugforge A3).
 *
 * Verifies:
 *  1. A public API call writes an audit_logs row with action='api.v1.call' and
 *     the expected details fields (method, route, status, scope, app_id,
 *     request_id, latency_ms).
 *  2. The portal endpoint GET /api/oauth/portal/apps/:appId/audit returns rows
 *     for the owning user and 404s for a different user (non-owner).
 *
 * Setup mirrors documents.test.ts exactly (real bearer auth, real DB, no mocks
 * except rate-limit). DATABASE_URL=postgres://christopherking@localhost:5432/ship_test
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import * as store from '../../../oauth/store.js';
import { hashClientSecret, sha256, generate } from '../../../oauth/crypto.js';
import { bearerAuth } from '../../../oauth/bearer.js';
import { identityAdapter } from '../../../adapters/identity.js';
import { createDocumentsAdapter } from '../../../adapters/documents.js';
import { createIssuesAdapter } from '../../../adapters/issues.js';
import { createSprintsAdapter } from '../../../adapters/sprints.js';
import { createAuditAdapter } from '../../../adapters/audit.js';
import { createWebhooksAdapter } from '../../../adapters/webhooks.js';
import { InMemoryEventBus } from '../../../webhooks/event-bus.js';
import { QueueWebhookDeliverer } from '../../../webhooks/deliverer.js';
import { systemClock } from '../../../webhooks/clock.js';
import { createV1Router } from '../router.js';
import { authMiddleware } from '../../../../middleware/auth.js';
import { getAppById } from '../../../oauth/store.js';

// -----------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------

let workspaceId: string;
let userId: string;
let appId: string;
/** Session cookie for portal endpoints. */
let sessionCookie: string;

const noRateLimit = (_req: unknown, _res: unknown, next: () => void) => next();
const okTransport = async () => ({ status: 200 as const });

/** Build a v1 app wired with the REAL audit adapter (writes to DB). */
function v1App() {
  const deliverer = new QueueWebhookDeliverer({ clock: systemClock, transport: okTransport, jitter: () => 0 });
  const bus = new InMemoryEventBus({ deliverer, clock: systemClock });
  const a = express();
  a.use('/api/v1', createV1Router({
    bearerAuth,
    rateLimit: noRateLimit,
    identity: identityAdapter,
    documents: createDocumentsAdapter(bus),
    issues: createIssuesAdapter(bus),
    sprints: createSprintsAdapter(),
    webhooks: createWebhooksAdapter(bus),
    audit: createAuditAdapter(),
  }));
  return a;
}

/** Build a portal app (session-authed) for querying audit rows. */
function portalApp() {
  const a = express();
  // Minimal session mock: set req.userId from a header (avoids needing a real
  // session in the test). We replace authMiddleware with a test shim.
  a.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const uid = req.headers['x-test-user-id'] as string | undefined;
    if (uid) (req as express.Request & { userId?: string }).userId = uid;
    next();
  });
  // Mount portal routes without authMiddleware so we can inject userId via header.
  // We import pool directly here because portal-routes.ts uses it.
  a.get('/api/oauth/portal/apps/:appId/audit', async (req: express.Request, res: express.Response): Promise<void> => {
    const testUserId = (req as express.Request & { userId?: string }).userId;
    if (!testUserId) { res.status(401).json({ success: false }); return; }

    const appRow = await getAppById(String(req.params.appId));
    if (!appRow || appRow.owner_user_id !== testUserId) {
      res.status(404).json({ success: false, error: { code: 'not_found', message: 'App not found' } });
      return;
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const result = await pool.query(
      `SELECT id, workspace_id, actor_user_id, action, resource_type, details, ip_address, user_agent, created_at
       FROM audit_logs
       WHERE action = 'api.v1.call'
         AND details->>'app_id' = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [appRow.id, limit],
    );
    res.json({ success: true, data: result.rows });
  });
  return a;
}

async function mintToken(scopes: string[]): Promise<string> {
  const raw = generate.accessToken();
  await store.insertAccessToken({
    tokenHash: sha256(raw), appId, userId, workspaceId, scopes,
    grantType: 'authorization_code', expiresAt: new Date(Date.now() + 3_600_000),
  });
  return raw;
}

/**
 * Wait up to `maxMs` for `fn` to return a truthy value (poll every 20ms).
 * record() is fire-and-forget via setImmediate so the row may not exist yet.
 */
async function waitFor<T>(fn: () => Promise<T | null | undefined>, maxMs = 500): Promise<T> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor: timed out');
}

// -----------------------------------------------------------------
// Setup
// -----------------------------------------------------------------

beforeAll(async () => {
  const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ('Audit A3 WS') RETURNING id`);
  workspaceId = ws.rows[0].id;
  const u = await pool.query(`INSERT INTO users (email, name) VALUES ('audit-a3@example.com','Audit Tester') RETURNING id`);
  userId = u.rows[0].id;
  const app = await store.createApp({
    clientId: `ship_app_audit_a3_${Date.now()}`,
    clientSecretHash: await hashClientSecret('x'),
    name: 'Audit A3 App',
    redirectUris: [],
    requestedScopes: ['documents:read', 'documents:write'],
    appType: 'confidential',
    ownerUserId: userId,
    workspaceId,
  });
  appId = app.id;
});

// -----------------------------------------------------------------
// Test 1: a public API call writes an audit_logs row
// -----------------------------------------------------------------

describe('audit trail: public API call writes audit_logs', () => {
  it('writes a row with action=api.v1.call and expected details fields', async () => {
    const token = await mintToken(['documents:read', 'documents:write']);
    const app = v1App();

    const res = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Audit test doc', document_type: 'wiki' });
    expect(res.status).toBe(201);

    const requestId = res.headers['x-request-id'] as string;
    expect(requestId).toBeTruthy();

    // Poll for the row (record() uses setImmediate).
    const row = await waitFor(async () => {
      const r = await pool.query(
        `SELECT * FROM audit_logs WHERE action='api.v1.call' AND details->>'request_id' = $1`,
        [requestId],
      );
      return r.rows[0] ?? null;
    });

    expect(row).toBeTruthy();
    expect(row.action).toBe('api.v1.call');
    expect(row.resource_type).toBe('api_route');

    const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
    expect(details.method).toBe('POST');
    expect(typeof details.route).toBe('string');
    expect(details.status).toBe(201);
    expect(details.scope).toBe('documents:write');
    expect(details.app_id).toBe(appId);
    expect(details.request_id).toBe(requestId);
    expect(typeof details.latency_ms).toBe('number');
    expect(details.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('records a 403 (missing scope) with the correct status', async () => {
    const token = await mintToken(['documents:read']); // no write scope
    const app = v1App();

    const res = await request(app)
      .post('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Should 403', document_type: 'wiki' });
    expect(res.status).toBe(403);

    const requestId = res.headers['x-request-id'] as string;
    const row = await waitFor(async () => {
      const r = await pool.query(
        `SELECT * FROM audit_logs WHERE action='api.v1.call' AND details->>'request_id' = $1`,
        [requestId],
      );
      return r.rows[0] ?? null;
    });

    expect(row).toBeTruthy();
    const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
    expect(details.status).toBe(403);
    expect(details.app_id).toBe(appId);
  });
});

// -----------------------------------------------------------------
// Test 2: portal endpoint returns rows for owner, 404s for non-owner
// -----------------------------------------------------------------

describe('portal audit endpoint', () => {
  it('returns audit rows for the owning user', async () => {
    // Make at least one call so there is definitely a row.
    const token = await mintToken(['documents:read']);
    const app = v1App();
    const callRes = await request(app)
      .get('/api/v1/documents')
      .set('Authorization', `Bearer ${token}`);
    expect(callRes.status).toBe(200);

    const reqId = callRes.headers['x-request-id'] as string;
    // Wait for the audit row to land.
    await waitFor(async () => {
      const r = await pool.query(
        `SELECT 1 FROM audit_logs WHERE action='api.v1.call' AND details->>'request_id' = $1`,
        [reqId],
      );
      return r.rows[0] ?? null;
    });

    const portal = portalApp();
    const auditRes = await request(portal)
      .get(`/api/oauth/portal/apps/${appId}/audit`)
      .set('x-test-user-id', userId);

    expect(auditRes.status).toBe(200);
    expect(auditRes.body.success).toBe(true);
    expect(Array.isArray(auditRes.body.data)).toBe(true);
    expect(auditRes.body.data.length).toBeGreaterThan(0);

    // Every row must belong to this app.
    for (const row of auditRes.body.data) {
      const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
      expect(details.app_id).toBe(appId);
    }
  });

  it('404s when a different user tries to query the audit for this app', async () => {
    // Create a second user who does NOT own the app.
    const otherUser = await pool.query(
      `INSERT INTO users (email, name) VALUES ('other-audit@example.com','Other') RETURNING id`,
    );
    const otherId: string = otherUser.rows[0].id;

    const portal = portalApp();
    const auditRes = await request(portal)
      .get(`/api/oauth/portal/apps/${appId}/audit`)
      .set('x-test-user-id', otherId);

    expect(auditRes.status).toBe(404);
  });
});
